const moment = require("moment-timezone");
const Balance = require("../models/BalanceModel");
const access = require("../models/reports-v2/access");
const { ReportError, sendReportError, badRequest } = require("../models/reports-v2/errors");
const { toCents, toMoney } = require("../models/reports-v2/money");
const { nowString, bounds } = require("../models/reports-v2/dates");
const validate = require("../models/reports-v2/validate");
// the Expense labels check (the same list and folding): a legacy note becomes a description
const { reservedLabelOf } = require("./Expense.controller");

/**
 * GET /balance's vault_balance (owner request, 2026-10-23): the admin's vault (533, cash
 * out of the till) on his own tenant, a 2-decimal string; null for any other login and
 * while the chart has no 533 (§7.8 not run). The token's user_type only picks who is
 * looked at: the live users row must still be that admin's (access.loadViewer, as the
 * correction routes), else null, never a refusal: the till figures stay as they were.
 */
async function vaultBalanceOf(req) {
    if (req.user?.user_type !== "admin") return null;
    let viewer;
    try {
        viewer = await access.loadViewer(req);
    } catch (error) {
        if (error instanceof ReportError) return null;
        throw error;
    }
    return viewer.isAdmin ? Balance.vaultBalance(viewer.databaseId) : null;
}

//get user balance (+ vault_balance: additive, older builds ignore it)
exports.getBalance = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const balance = await Balance.getBalance(database_id);
        res.status(200).send({ ...balance, vault_balance: await vaultBalanceOf(req) });
    } catch (error) {
        next(error);
    }
};

//get user balance
exports.getBalanceByUserId = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const balance = await Balance.getBalanceByUserId(database_id);
        res.status(200).json(balance);
    } catch (error) {
        next(error);
    }
};

//get all users balance
exports.getAllUsersBalance = async (req, res, next) => {
    try {
        const balance = await Balance.getAllUsersBalance();
        res.status(200).json(balance);
    } catch (error) {
        next(error);
    }
};

//get transfer accounts
exports.getTransferAccounts = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const accounts = await Balance.getTransferAccounts(database_id);
        res.status(200).json(accounts);
    } catch (error) {
        next(error);
    }
};

// get cash transactions history
exports.getCashTransactions = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const { start, end, account } = req.params;
        const results = await Balance.getCashTransactions(
            start,
            end,
            database_id,
            account,
        );
        res.status(200).send(results);
    } catch (error) {
        next(error);
    }
};

// self transfer
exports.selfTransfer = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const data = req.body;
        const result = await Balance.selfTransfer(database_id, data);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

// ---------------------------------------------------------------- cash corrections
//
// The admin's cash corrections (owner decisions C1–C4, Q4–Q10, 2026-10-22; plan §8 "Cash
// corrections with reasons"). Every route runs `admin` (any other token → 403 before any
// SQL), then loadAdmin: the live users row must still be the admin's (a deleted login, a
// changed role or tenant → 401 "Please log in again."). The tenant is always that
// viewer's own database_id (C2): no body or query key names a shop.
//
// Every body / query field is read explicitly and unknown keys are ignored; nothing is
// bound as an object (mysql2 expands objects, and the pool runs multipleStatements).
// Money is checked and bound as a 2-decimal string (cents, DECIMAL(10,2)). Coded
// refusals answer { code, message, field? } (400 BAD_REQUEST, 409 NOT_SET_UP /
// NOT_EDITABLE / DIRECTION_MISMATCH / SAFE_OPENING_EXISTS / BEFORE_SAFE_OPENING); a
// malformed, unknown, deleted, other-tenant or non-correction id gets the same 404, so
// ids cannot be probed; unexpected errors go to the global errorHandler.
//
// Follow-ups (owner answers F1–F4, 2026-10-22): every write records who (the live admin
// login's user_id) and when (Beirut now) in the audit trail (F1, §7.9; GET
// /balance/corrections/audit); the admin's one opening safe balance has its own routes
// (F2, /balance/safe-opening); a legacy note (old builds, or an edit keeping an old
// correction) may not be a reserved voucher label (F3).
//
// "Vault" (owner request, 2026-10-23): the messages below call 533 the vault; the codes,
// fields, reason keys, routes and answer keys (outside_till, safe_opening) are unchanged.

const CORRECTION_NOT_FOUND = { message: "Correction not found." };
const NOT_SET_UP = {
    code: "NOT_SET_UP",
    message: "This reason is not set up yet: the database update (§7.8) has not been run.",
};
const NOT_EDITABLE_TEXT =
    "This entry is not a plain two-line cash correction, so it cannot be changed here.";
const AUDIT_NOT_SET_UP = {
    code: "NOT_SET_UP",
    message: "The correction history is not set up yet: the database update (§7.9) has not been run.",
};

// DECIMAL(10,2): cents only, at most 99,999,999.99; at most 8 whole digits, so a longer
// figure is a 400 here, never a toCents RangeError (a 500)
const MAX_CENTS = 9999999999;
const AMOUNT_RE = /^\d{1,8}(\.\d{1,2})?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// journal_description / journal_items.notes are varchar(255) utf8mb3: no 4-byte character
const NOTES_MAX = 255;
const FOUR_BYTE_CHAR = /[\u{10000}-\u{10FFFF}]/u;
// ids per bulk change, and rows per list page (the page can select a whole page)
const MAX_IDS = 500;
const MAX_PAGE = 500;

const REASON_KEYS = Object.keys(Balance.CORRECTION_REASONS);
const EDIT_REASON_KEYS = [...REASON_KEYS, ...Object.keys(Balance.LEGACY_REASONS)];
const LIST_REASON_KEYS = [...REASON_KEYS, "legacy"];
const AUDIT_PAGE = 500;

const fail = (error, res, next) =>
    error instanceof ReportError ? sendReportError(res, error) : next(error);

const bodyOf = (req) =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

/** A correction id from the URL: digits only, no sign, space, exponent or leading zero. */
const toCorrectionId = (value) => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
};

/** A reason key from `allowed`, else 400 (field reason). */
function parseReason(value, allowed) {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw badRequest("reason", "Pick what this correction is.");
    }
    return value;
}

/** The amount as a 2-decimal string, or a 400 (the partner-share rule). */
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

/** '531' | '532' as a STRING (a number from an old build is accepted and converted). */
function parseMoneyAccount(value) {
    const text =
        typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
            ? String(value)
            : null;
    if (!Balance.MONEY_ACCOUNTS.includes(text)) {
        throw badRequest("money_account", "Pick Cash or Whish.");
    }
    return text;
}

/** The note: required, trimmed, 1–255 characters, no 4-byte character. */
function parseNotes(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw badRequest("transaction_notes", "Write what this correction is for.");
    }
    const text = value.trim();
    if (FOUR_BYTE_CHAR.test(text)) {
        throw badRequest(
            "transaction_notes",
            "Emoji and similar symbols are not supported in notes.",
        );
    }
    if (Array.from(text).length > NOTES_MAX) {
        throw badRequest("transaction_notes", `Keep the note to ${NOTES_MAX} characters.`);
    }
    return text;
}

/**
 * F3: a legacy correction's note becomes its voucher's description, which Cash history,
 * the statements and the v1 screens read; a reserved label (Expense's list and folding,
 * e.g. 'Invoice', 'transfer ', 'Moved to Safe') is refused.
 */
function refuseReservedLabel(notes) {
    const reserved = reservedLabelOf(notes);
    if (reserved) {
        throw badRequest(
            "transaction_notes",
            `"${reserved}" is reserved for system entries, please use another note.`,
        );
    }
    return notes;
}

/** An optional note (the opening safe balance): absent or blank → null, else parseNotes. */
function parseOptionalNotes(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && !value.trim()) return null;
    return parseNotes(value);
}

/** An inclusive 'YYYY-MM-DD' from 2000 to 2099, or null when absent. */
function parseDay(value, field) {
    if (value === undefined || value === null || value === "") return null;
    if (
        typeof value !== "string" ||
        !DAY_RE.test(value) ||
        !moment.tz(value, "YYYY-MM-DD", true, "UTC").isValid() ||
        value < "2000-01-01" ||
        value > "2099-12-31"
    ) {
        throw badRequest(field, "Pick a valid date.");
    }
    return value;
}

/** The opening safe balance's day (F2): required, valid, never after `today` (Beirut). */
function parseOpeningDay(value, today) {
    const day = parseDay(value, "date");
    if (day === null) throw badRequest("date", "Pick the day this balance was in the vault.");
    if (day > today) throw badRequest("date", "Pick a day that is not in the future.");
    return day;
}

/** Who and when, for the audit trail (F1): the live admin login, Beirut now. */
const actorOf = (req, at) => ({ user_id: Number(req.correctionViewer.userId), at });

/** The bulk ids: an array of 1–500 positive ids (numbers or digit strings), deduplicated. */
function parseIds(value) {
    const message = `Select from 1 to ${MAX_IDS} corrections.`;
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IDS) {
        throw badRequest("ids", message);
    }
    const ids = value.map((v) =>
        typeof v === "number" ? (Number.isSafeInteger(v) && v > 0 ? v : null) : toCorrectionId(v),
    );
    if (ids.some((id) => id === null)) throw badRequest("ids", message);
    return [...new Set(ids)];
}

/** The answer to a model outcome other than OK. */
function sendOutcome(res, result) {
    switch (result.status) {
        case Balance.NOT_FOUND:
            return res
                .status(404)
                .json(result.ids ? { ...CORRECTION_NOT_FOUND, ids: result.ids } : CORRECTION_NOT_FOUND);
        case Balance.NOT_SET_UP:
            return res.status(409).json(NOT_SET_UP);
        case Balance.NOT_EDITABLE:
            return res.status(409).json({ code: "NOT_EDITABLE", message: NOT_EDITABLE_TEXT, ids: result.ids });
        case Balance.DIRECTION_MISMATCH:
            return res.status(409).json({
                code: "DIRECTION_MISMATCH",
                message:
                    result.direction === "in"
                        ? `${result.ids.length} of the selected corrections took money out of the till; this reason puts money in.`
                        : `${result.ids.length} of the selected corrections put money into the till; this reason takes money out.`,
                ids: result.ids,
            });
        case Balance.STAYS_LEGACY_ONLY:
            return res.status(400).json({
                code: "BAD_REQUEST",
                field: "reason",
                message: "Only an old correction can stay an old correction. Pick a reason.",
            });
        case Balance.AUDIT_NOT_SET_UP:
            return res.status(409).json(AUDIT_NOT_SET_UP);
        case Balance.SAFE_OPENING_EXISTS:
            return res.status(409).json({
                code: "SAFE_OPENING_EXISTS",
                message: `There is already an opening vault balance (${result.journal_number}): edit or delete it instead.`,
                journal_id: result.journal_id,
            });
        case Balance.OPENING_AFTER_FIRST_MOVE:
            return res.status(400).json({
                code: "BAD_REQUEST",
                field: "date",
                message: `Pick a day on or before ${result.max_date}, the first movement of the vault.`,
                max_date: result.max_date,
            });
        case Balance.BEFORE_SAFE_OPENING:
            return res.status(409).json({
                code: "BEFORE_SAFE_OPENING",
                message: `${result.ids.length} of the selected corrections ${result.ids.length === 1 ? "is" : "are"} dated before the opening vault balance (${result.opening_date}): date the opening on or before ${result.earliest} first.`,
                ids: result.ids,
                opening_date: result.opening_date,
            });
        default:
            throw new Error(`Unexpected correction outcome: ${result.status}`);
    }
}

// Router middleware of every correction route, after `admin`: the live users row
exports.loadAdmin = async (req, res, next) => {
    try {
        const viewer = await access.loadViewer(req);
        if (!viewer.isAdmin) {
            return res.status(403).json({ message: "Only the admin can do this." });
        }
        req.correctionViewer = viewer;
        return next();
    } catch (error) {
        return fail(error, res, next);
    }
};

// POST /balance/correct — a new correction on the admin's own till, dated now (Q10).
// Body { reason, money_account, amount, transaction_notes }; without a reason (old
// builds, Q6) { transaction_type: 'ADD' | 'REMOVE', money_account, amount,
// transaction_notes } posts a legacy correction against 101, as before.
exports.correctBalance = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const legacy = body.reason === undefined || body.reason === null;
        const reason = legacy ? null : parseReason(body.reason, REASON_KEYS);
        let direction = null;
        if (legacy) {
            if (body.transaction_type !== "ADD" && body.transaction_type !== "REMOVE") {
                throw badRequest("transaction_type", "Pick Add or Remove.");
            }
            direction = body.transaction_type === "ADD" ? "in" : "out";
        } else {
            direction = Balance.CORRECTION_REASONS[reason].direction;
        }
        const notes = parseNotes(body.transaction_notes);
        const entry = {
            reason,
            direction,
            money_account: parseMoneyAccount(body.money_account),
            amount: parseAmount(body.amount),
            // F3: a legacy note is the voucher's description
            notes: legacy ? refuseReservedLabel(notes) : notes,
        };
        const at = nowString();
        const result = await Balance.createCorrection(
            req.correctionViewer.databaseId,
            entry,
            at,
            actorOf(req, at),
        );
        if (result.status !== Balance.OK) return sendOutcome(res, result);
        return res.status(201).json({
            message: "Balance has been updated successfully!",
            journal_id: result.journal_id,
            journal_number: result.journal_number,
            reason: result.reason,
            balance: result.balance,
            negative_till: result.negative_till,
            negative_outside_till: result.negative_outside_till,
        });
    } catch (error) {
        return fail(error, res, next);
    }
};

// GET /balance/corrections — the list (C4). Query: from, to ('YYYY-MM-DD', inclusive,
// each optional), reason (a reason key or 'legacy'), search (in the notes),
// money_account ('531' | '532'), direction ('in' | 'out'), limit (1–500, 50), offset.
exports.listCorrections = async (req, res, next) => {
    try {
        const q = req.query && typeof req.query === "object" ? req.query : {};
        const from = parseDay(q.from, "from");
        const to = parseDay(q.to, "to");
        if (from && to && from > to) throw badRequest("from", "The start date is after the end date.");
        const reason = validate.enumOf(q.reason, "reason", LIST_REASON_KEYS, { def: null });
        const pattern = validate.search(q.search, "search");
        // the notes are utf8mb3 (4-byte characters are refused on write, so none can
        // match); bound against them, such a pattern is a MySQL collation error (a 500)
        if (pattern && FOUR_BYTE_CHAR.test(pattern)) {
            throw badRequest("search", "Emoji and similar symbols cannot be searched.");
        }
        const moneyAccount =
            q.money_account === undefined || q.money_account === null || q.money_account === ""
                ? null
                : parseMoneyAccount(q.money_account);
        const direction = validate.enumOf(q.direction, "direction", ["in", "out"], { def: null });
        const found = await Balance.listCorrections(req.correctionViewer.databaseId, {
            lo: from ? bounds(from, from).lo : null,
            hi: to ? bounds(to, to).hi : null,
            reason,
            pattern,
            money_account: moneyAccount,
            direction,
            limit: validate.limit(q.limit, { max: MAX_PAGE, def: 50 }),
            offset: validate.offset(q.offset),
            today: nowString().slice(0, 10),
        });
        return res.status(200).json(found);
    } catch (error) {
        return fail(error, res, next);
    }
};

// PUT /balance/corrections/:journal_id — edit (C4): { reason, money_account, amount,
// transaction_notes }; reason legacy_in / legacy_out keeps an old correction as one.
// The date never changes.
exports.updateCorrection = async (req, res, next) => {
    try {
        const journalId = toCorrectionId(req.params.journal_id);
        if (!journalId) return res.status(404).json(CORRECTION_NOT_FOUND);
        const body = bodyOf(req);
        const reason = parseReason(body.reason, EDIT_REASON_KEYS);
        const notes = parseNotes(body.transaction_notes);
        const edit = {
            reason,
            money_account: parseMoneyAccount(body.money_account),
            amount: parseAmount(body.amount),
            // F3: kept an old correction, the note stays its description
            notes: Object.prototype.hasOwnProperty.call(Balance.LEGACY_REASONS, reason)
                ? refuseReservedLabel(notes)
                : notes,
        };
        const result = await Balance.updateCorrection(
            req.correctionViewer.databaseId,
            journalId,
            edit,
            actorOf(req, nowString()),
        );
        if (result.status !== Balance.OK) return sendOutcome(res, result);
        return res.status(200).json({
            message: "Correction updated.",
            journal_id: result.journal_id,
            journal_number: result.journal_number,
            reason: result.reason,
            balance: result.balance,
            negative_till: result.negative_till,
            negative_outside_till: result.negative_outside_till,
        });
    } catch (error) {
        return fail(error, res, next);
    }
};

// DELETE /balance/corrections/:journal_id — soft delete (C4): the voucher and its lines
exports.deleteCorrection = async (req, res, next) => {
    try {
        const journalId = toCorrectionId(req.params.journal_id);
        if (!journalId) return res.status(404).json(CORRECTION_NOT_FOUND);
        const result = await Balance.deleteCorrection(
            req.correctionViewer.databaseId,
            journalId,
            actorOf(req, nowString()),
        );
        if (result.status !== Balance.OK) return sendOutcome(res, result);
        return res.status(200).json({
            message: "Correction deleted.",
            journal_id: result.journal_id,
            journal_number: result.journal_number,
            balance: result.balance,
            negative_till: result.negative_till,
            negative_outside_till: result.negative_outside_till,
        });
    } catch (error) {
        return fail(error, res, next);
    }
};

// POST /balance/corrections/reclassify — one reason for several corrections (C4, bulk):
// { ids: number[] (1–500), reason, dry_run?: boolean }. All or nothing.
exports.reclassifyCorrections = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const ids = parseIds(body.ids);
        const reason = parseReason(body.reason, REASON_KEYS);
        const dryRun = validate.bool(body.dry_run, "dry_run");
        const result = await Balance.reclassifyCorrections(
            req.correctionViewer.databaseId,
            ids,
            reason,
            { dryRun },
            actorOf(req, nowString()),
        );
        if (result.status !== Balance.OK) return sendOutcome(res, result);
        return res.status(200).json({
            message: dryRun
                ? `${result.updated} of ${result.count} corrections would change.`
                : `${result.updated} of ${result.count} corrections changed.`,
            dry_run: dryRun,
            reason,
            count: result.count,
            updated: result.updated,
            unchanged: result.unchanged,
            total: result.total,
            into_till: result.into_till,
            out_of_till: result.out_of_till,
            balance: result.balance,
            negative_till: result.negative_till,
            negative_outside_till: result.negative_outside_till,
        });
    } catch (error) {
        return fail(error, res, next);
    }
};

// GET /balance/corrections/audit — the correction history (F1, §7.9), newest first.
// Query (all optional): journal_id (one voucher's history), action (create | edit |
// delete | reclassify), from, to ('YYYY-MM-DD', inclusive, of the change's Beirut time),
// limit (1–500, 50), offset.
exports.listCorrectionAudit = async (req, res, next) => {
    try {
        const q = req.query && typeof req.query === "object" ? req.query : {};
        const journalId = validate.int(q.journal_id, "journal_id", { min: 1, def: null });
        const action = validate.enumOf(q.action, "action", Balance.AUDIT_ACTIONS, { def: null });
        const from = parseDay(q.from, "from");
        const to = parseDay(q.to, "to");
        if (from && to && from > to) throw badRequest("from", "The start date is after the end date.");
        const found = await Balance.listAudit(req.correctionViewer.databaseId, {
            journal_id: journalId,
            action,
            lo: from ? bounds(from, from).lo : null,
            hi: to ? bounds(to, to).hi : null,
            limit: validate.limit(q.limit, { max: AUDIT_PAGE, def: 50 }),
            offset: validate.offset(q.offset),
        });
        return res.status(200).json(found);
    } catch (error) {
        return fail(error, res, next);
    }
};

// ---------------------------------------------------------------- opening safe balance
//
// F2 (2026-10-22): the cash already in the safe when the data starts, ONE entry on the
// admin's tenant: Dr 533 / Cr 101, SOB<journal_id>, dated by the admin (a day, stored at
// 00:00:00; on or before the safe's first other movement, never in the future). Body {
// amount, date: 'YYYY-MM-DD', transaction_notes? }. It never touches the till.

/** The opening's answer after a write. */
const openingAnswer = (message, result) => ({
    message,
    journal_id: result.journal_id,
    journal_number: result.journal_number,
    safe_opening: result.safe_opening,
    balance: result.balance,
    negative_till: result.negative_till,
    negative_outside_till: result.negative_outside_till,
});

/** The opening's body: { amount, day, notes }. */
const openingEntryOf = (req, today) => {
    const body = bodyOf(req);
    return {
        amount: parseAmount(body.amount),
        day: parseOpeningDay(body.date, today),
        notes: parseOptionalNotes(body.transaction_notes),
    };
};

// POST /balance/safe-opening — 201; 409 SAFE_OPENING_EXISTS while one exists
exports.createSafeOpening = async (req, res, next) => {
    try {
        const at = nowString();
        const entry = openingEntryOf(req, at.slice(0, 10));
        const result = await Balance.createSafeOpening(
            req.correctionViewer.databaseId,
            entry,
            actorOf(req, at),
        );
        if (result.status !== Balance.OK) return sendOutcome(res, result);
        return res.status(201).json(openingAnswer("Opening vault balance saved.", result));
    } catch (error) {
        return fail(error, res, next);
    }
};

// PUT /balance/safe-opening/:journal_id — amount, date and note
exports.updateSafeOpening = async (req, res, next) => {
    try {
        const journalId = toCorrectionId(req.params.journal_id);
        if (!journalId) return res.status(404).json(CORRECTION_NOT_FOUND);
        const at = nowString();
        const entry = openingEntryOf(req, at.slice(0, 10));
        const result = await Balance.updateSafeOpening(
            req.correctionViewer.databaseId,
            journalId,
            entry,
            actorOf(req, at),
        );
        if (result.status !== Balance.OK) return sendOutcome(res, result);
        return res.status(200).json(openingAnswer("Opening vault balance updated.", result));
    } catch (error) {
        return fail(error, res, next);
    }
};

// DELETE /balance/safe-opening/:journal_id — soft delete (a new one may then be made)
exports.deleteSafeOpening = async (req, res, next) => {
    try {
        const journalId = toCorrectionId(req.params.journal_id);
        if (!journalId) return res.status(404).json(CORRECTION_NOT_FOUND);
        const result = await Balance.deleteSafeOpening(
            req.correctionViewer.databaseId,
            journalId,
            actorOf(req, nowString()),
        );
        if (result.status !== Balance.OK) return sendOutcome(res, result);
        return res.status(200).json(openingAnswer("Opening vault balance deleted.", result));
    } catch (error) {
        return fail(error, res, next);
    }
};
