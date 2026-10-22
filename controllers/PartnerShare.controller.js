const moment = require("moment-timezone");
const PartnerShare = require("../models/PartnerShareModel");
const access = require("../models/reports-v2/access");
const { ReportError, sendReportError, badRequest } = require("../models/reports-v2/errors");
const { toCents, toMoney } = require("../models/reports-v2/money");
const { nowBeirut, monthOf, addMonths } = require("../models/reports-v2/dates");
const validate = require("../models/reports-v2/validate");
const { PARTNER_START_DAY } = require("../models/reports-v2/partner");

// /partner-shares (plan §8 Phase 7.1 part D). Mounted as
//
//     app.use("/partner-shares", auth, PartnerSharesRoutes)
//
// and the router runs `owner` (staff → 403 before any SQL) and loadViewer below on
// every route: tokens never expire, so the live users row is read and must still match
// the token (a deleted login, a changed role or tenant, or a token without database_id —
// signed by the profile screen before its fix — answer 401 "Please log in again.";
// middleware/auth.js already refuses the last kind). Every handler uses that
// live viewer (req.partner), never the token.
//
// Every body field is read explicitly and unknown keys are ignored; nothing is bound as
// an object (mysql2 expands objects, and the pool runs multipleStatements). Ids are
// strict digit strings, and a malformed, unknown, deleted or other-shop id gets the same
// 404, so ids cannot be probed. Coded refusals answer { code, message, field? }; state
// conflicts { message, status }; unexpected errors go to the global errorHandler.

const SHARE_NOT_FOUND = { message: "Share entry not found." };
const NOT_SET_UP = { message: "Partner shares are not set up yet." };
const ADMIN_ONLY = { message: "Only the admin can do this." };
const USER_ONLY = { message: "Only a shop owner records a share taken." };

// DECIMAL(10,2): cents only, at most 99,999,999.99; at most 8 whole digits, so a longer
// figure is a 400 here, never a toCents RangeError (a 500)
const MAX_CENTS = 9999999999;
const AMOUNT_RE = /^\d{1,8}(\.\d{1,2})?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 255;
const STATUSES = ["pending", "approved", "rejected", "reversed", "deleted", "all"];

const fail = (error, res, next) =>
    error instanceof ReportError ? sendReportError(res, error) : next(error);

/** A share id from the URL: digits only, no sign, space, exponent or leading zero. */
const toShareId = (value) => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
};

/** The amount as a 2-decimal string, or a 400 (the Users-form rule). */
function parseAmount(value) {
    const message = "Enter an amount above 0 with at most 2 decimals.";
    const ok =
        (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) &&
        AMOUNT_RE.test(String(value)) &&
        String(value).length <= 16;
    if (!ok) throw badRequest("amount", message);
    const cents = toCents(String(value));
    if (cents < 1 || cents > MAX_CENTS) throw badRequest("amount", message);
    return toMoney(cents); // a string: no float is ever bound
}

/** '531' | '532' as a STRING (an ENUM bound as a number is read as a position). */
function parseMoneyAccount(value) {
    const text =
        typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
            ? String(value)
            : null;
    if (!PartnerShare.MONEY_ACCOUNTS.includes(text)) {
        throw badRequest("money_account", "Pick Cash or Whish.");
    }
    return text;
}

/**
 * The back-dating window (PA16, confirmed by the owner 2026-10-22, L1-8): from the later
 * of the start day and the first day of the previous Beirut month, to Beirut today.
 */
function dateWindow(now) {
    const today = now.format("YYYY-MM-DD");
    const previous = `${addMonths(monthOf(now), -1)}-01`;
    return { min_date: previous > PARTNER_START_DAY ? previous : PARTNER_START_DAY, today };
}

const isDay = (value) =>
    typeof value === "string" &&
    DAY_RE.test(value) &&
    moment.tz(value, "YYYY-MM-DD", true, "UTC").isValid();

/**
 * taken_date: absent → today; else a real day inside the window. Nothing before the start
 * day is ever accepted: the owner rejected opening entries (PA13, L1-5, 2026-10-22).
 */
function parseTakenDate(value, now) {
    const { min_date, today } = dateWindow(now);
    const day = value === undefined || value === null || value === "" ? today : value;
    if (isDay(day) && day >= min_date && day <= today) return day;
    const from = moment.tz(min_date, "YYYY-MM-DD", true, "UTC").format("D MMMM YYYY");
    throw badRequest("taken_date", `Pick a day from ${from} to today.`);
}

/** A note or a reason: absent, null or "" → null; else at most 255 characters. */
function parseText(value, field) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw badRequest(field, `${field} is not valid.`);
    const text = value.trim();
    if (!text) return null;
    if (Array.from(text).length > TEXT_MAX) {
        throw badRequest(field, `Keep it to ${TEXT_MAX} characters.`);
    }
    return text;
}

const bodyOf = (req) =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

// The answer when the entry is not in the state the action needs (409 with its status)
const CONFLICT_TEXT = {
    approved: "This entry is already approved.",
    rejected: "This entry was rejected.",
    reversed: "This entry was reversed.",
    pending: "This entry was changed meanwhile. Reload and try again.",
};
const sendOutcome = (res, result, action) => {
    switch (result.status) {
        case PartnerShare.NOT_FOUND:
            return res.status(404).json(SHARE_NOT_FOUND);
        case PartnerShare.NOT_SET_UP:
            return res.status(409).json(NOT_SET_UP);
        case PartnerShare.NO_VOUCHER:
            return res.status(409).json({
                message: `The approval entry of ${result.share_number} is missing.`,
            });
        case PartnerShare.CONFLICT: {
            let message = CONFLICT_TEXT[result.current] || CONFLICT_TEXT.pending;
            if (action === "delete" && result.current !== "pending") {
                message =
                    "Only a pending entry can be deleted; an approved entry can be reversed by the admin.";
            } else if (action === "reverse" && result.current !== "approved") {
                message = "Only an approved entry can be reversed.";
            } else if (action === "reverse") {
                message = CONFLICT_TEXT.pending;
            }
            return res.status(409).json({ message, status: result.current });
        }
        default:
            throw new Error(`Unexpected share outcome: ${result.status}`);
    }
};

// No amounts in the payloads: io.emit reaches every connected client
const emitUpdated = (req, result, status) =>
    req.io?.emit("partnerShareUpdated", {
        database_id: result.database_id,
        share_number: result.share_number,
        status,
    });

// Router middleware: the live viewer (access.loadViewer, one read of the users row)
exports.loadViewer = async (req, res, next) => {
    try {
        const viewer = await access.loadViewer(req);
        // `owner` already refused staff tokens; a live row must agree (loadViewer checks
        // user_type against the token)
        if (viewer.userType !== "admin" && viewer.userType !== "user") {
            return res.status(403).json({ message: "Only the account owner can do this" });
        }
        req.partner = viewer;
        return next();
    } catch (error) {
        return fail(error, res, next);
    }
};

// POST /partner-shares — a user records a share he took: pending until the admin approves
exports.create = async (req, res, next) => {
    try {
        if (req.partner.userType !== "user") return res.status(403).json(USER_ONLY);
        const now = nowBeirut();
        const body = bodyOf(req);
        const entry = {
            amount: parseAmount(body.amount),
            money_account: parseMoneyAccount(body.money_account),
            taken_date: parseTakenDate(body.taken_date, now),
            note: parseText(body.note, "note"),
        };
        const result = await PartnerShare.create(req.partner, entry, now);
        if (result.status === PartnerShare.FORBIDDEN) return res.status(403).json(USER_ONLY);
        if (result.status !== PartnerShare.OK) return sendOutcome(res, result, "create");

        req.io?.emit("partnerShareAdded", { database_id: result.database_id });
        return res.status(201).json({
            share_id: result.share_id,
            share_number: result.share_number,
            status: "pending",
        });
    } catch (error) {
        return fail(error, res, next);
    }
};

// POST /partner-shares/search — the admin: every user shop (optionally one); a user: his
// own shop only, whatever the body says
exports.search = async (req, res, next) => {
    try {
        const now = nowBeirut();
        const body = bodyOf(req);
        const admin = req.partner.isAdmin;
        const status = validate.enumOf(body.status, "status", STATUSES, {
            def: admin ? "pending" : "all",
        });
        const databaseId = admin
            ? validate.int(body.database_id, "database_id", { min: 1, def: null })
            : null;
        const q = {
            status,
            databaseId,
            limit: validate.limit(body.limit),
            offset: validate.offset(body.offset),
        };
        const found = await PartnerShare.search(req.partner, q, now);
        const { min_date, today } = dateWindow(now);
        const answer = {
            set_up: found.set_up,
            start_date: PARTNER_START_DAY,
            min_date,
            today,
            total: found.total,
            rows: found.rows,
        };
        if (admin) answer.shops = found.shops;
        return res.status(200).json(answer);
    } catch (error) {
        return fail(error, res, next);
    }
};

// GET /partner-shares/pending-count — the admin's navbar badge
exports.pendingCount = async (req, res, next) => {
    try {
        if (!req.partner.isAdmin) return res.status(403).json(ADMIN_ONLY);
        return res.status(200).json({ count: await PartnerShare.pendingCount() });
    } catch (error) {
        return fail(error, res, next);
    }
};

// PATCH /partner-shares/:share_id/approve — posts the SHR voucher (part E)
exports.approve = async (req, res, next) => {
    try {
        if (!req.partner.isAdmin) return res.status(403).json(ADMIN_ONLY);
        const shareId = toShareId(req.params.share_id);
        if (!shareId) return res.status(404).json(SHARE_NOT_FOUND);
        const result = await PartnerShare.approve(req.partner, shareId, nowBeirut());
        if (result.status !== PartnerShare.OK) return sendOutcome(res, result, "approve");
        emitUpdated(req, result, "approved");
        return res.status(200).json({
            message: "Share taken approved.",
            share_number: result.share_number,
            journal_number: result.journal_number,
        });
    } catch (error) {
        return fail(error, res, next);
    }
};

// PATCH /partner-shares/:share_id/reject — body { reason? }
exports.reject = async (req, res, next) => {
    try {
        if (!req.partner.isAdmin) return res.status(403).json(ADMIN_ONLY);
        const shareId = toShareId(req.params.share_id);
        if (!shareId) return res.status(404).json(SHARE_NOT_FOUND);
        const reason = parseText(bodyOf(req).reason, "reason");
        const result = await PartnerShare.reject(req.partner, shareId, reason, nowBeirut());
        if (result.status !== PartnerShare.OK) return sendOutcome(res, result, "reject");
        emitUpdated(req, result, "rejected");
        return res.status(200).json({ message: "Share taken rejected." });
    } catch (error) {
        return fail(error, res, next);
    }
};

// DELETE /partner-shares/:share_id — the admin: any pending entry; a user: his own
// pending entry (withdraw). Soft delete.
exports.remove = async (req, res, next) => {
    try {
        const shareId = toShareId(req.params.share_id);
        if (!shareId) return res.status(404).json(SHARE_NOT_FOUND);
        const result = await PartnerShare.remove(req.partner, shareId, nowBeirut());
        if (result.status !== PartnerShare.OK) return sendOutcome(res, result, "delete");
        emitUpdated(req, result, "deleted");
        return res.status(200).json({
            message: req.partner.isAdmin ? "Share taken deleted." : "Share taken withdrawn.",
        });
    } catch (error) {
        return fail(error, res, next);
    }
};

// POST /partner-shares/:share_id/reverse — posts SHR####-R (PA3)
exports.reverse = async (req, res, next) => {
    try {
        if (!req.partner.isAdmin) return res.status(403).json(ADMIN_ONLY);
        const shareId = toShareId(req.params.share_id);
        if (!shareId) return res.status(404).json(SHARE_NOT_FOUND);
        const result = await PartnerShare.reverse(req.partner, shareId, nowBeirut());
        if (result.status !== PartnerShare.OK) return sendOutcome(res, result, "reverse");
        emitUpdated(req, result, "reversed");
        return res.status(200).json({
            message: "Share taken reversed.",
            reversal_journal_number: result.reversal_journal_number,
        });
    } catch (error) {
        return fail(error, res, next);
    }
};
