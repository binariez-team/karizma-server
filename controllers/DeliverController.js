const pool = require("../config/database");
const DeliverInvoice = require("../models/DeliverModel");
const access = require("../models/reports-v2/access");
const { ReportError, sendReportError } = require("../models/reports-v2/errors");
const { parseCapCheckBody, getCapCheck } = require("../models/reports-v2/deliverCap");

// GET /deliver/recipients — { database_id, database_name } rows, the same for every
// role. Also answers the deprecated /deliver/users and /user-deliver/users, so older
// web/Electron builds get the same safe list (no admin tenant) as the new screen.
exports.getRecipients = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const recipients = await DeliverInvoice.getRecipients(database_id);
        res.status(200).send(recipients);
    } catch (error) {
        next(error);
    }
};

// Who may see a recipient's quantities on the deliver screen. Admin only for now: it
// shows another tenant's stock, which users and staff otherwise never see. To open it
// to users later, widen this one check (the client's DeliverService.canSeeRecipientStock
// is the matching switch); getRecipientStock still limits every caller to tenants it
// may deliver to.
const canSeeRecipientStock = (user) => user?.user_type === "admin";

// GET /deliver/recipients/:database_id/stock — [{ product_id, quantity }]
exports.getRecipientStock = async (req, res, next) => {
    try {
        // before anything else: refused callers never reach the database
        if (!canSeeRecipientStock(req.user)) {
            return res
                .status(403)
                .send({ message: "You don't have permission to do this" });
        }
        const stock = await DeliverInvoice.getRecipientStock(
            req.params.database_id,
            req.user.database_id,
        );
        res.status(200).send(stock);
    } catch (error) {
        next(error);
    }
};

// POST /deliver/cap-check — the recipient's assets-cap use now and after the draft
// delivery (plan §8 Phase 7 item 3, Phase 7.1 PA14): { database_id, items: [{
// product_id, quantity }], order_id? } → the figures of models/reports-v2/deliverCap.js.
// Non-blocking, and the admin sender only (owner answer 2026-10-22): users and staff
// never see another shop's cap. The token's role is checked before any SQL, then the
// live login (401 when it no longer matches the token) and the same recipient rule as
// delivering (403 "You can't deliver to this user.").
exports.capCheck = async (req, res, next) => {
    try {
        if (req.user?.user_type !== "admin") {
            return res
                .status(403)
                .send({ message: "You don't have permission to do this" });
        }
        const viewer = await access.loadViewer(req);
        if (!viewer.isAdmin) {
            return res
                .status(403)
                .send({ message: "You don't have permission to do this" });
        }
        const params = parseCapCheckBody(req.body);
        params.receiver = await DeliverInvoice.assertRecipient(
            pool,
            params.receiver,
            viewer.databaseId,
        );
        const result = await getCapCheck(params, viewer.databaseId);
        res.status(200).send(result);
    } catch (error) {
        if (error instanceof ReportError) return sendReportError(res, error);
        next(error);
    }
};

exports.createDeliverInvoice = async (req, res, next) => {
    try {
        const io = req.io;
        const fromDatabase = req.user;
        const { order, items } = req.body;

        await DeliverInvoice.create(order, items, fromDatabase);
        // const [toDatabase] = await User.getById(order.database_id);
        io.emit("deliverAdded", order.database_id);
        res.status(201).send({
            message: "Order created successfully!",
        });
    } catch (error) {
        next(error);
    }
};

exports.updateDeliverInvoice = async (req, res, next) => {
    try {
        const user = req.user;
        const { order, items } = req.body;
        await DeliverInvoice.update(order, items, user);
        res.status(200).send({
            message: "Order updated successfully!",
        });
    } catch (error) {
        if (error.message === "approved") {
            return res.status(400).send({
                error: "Order has been approved by user!",
            });
        } else {
            next(error);
        }
    }
};

exports.deleteDeliverInvoice = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { database_id } = req.user;
        await DeliverInvoice.delete(id, database_id);
        res.status(200).send({
            message: "Order deleted successfully!",
        });
    } catch (error) {
        if (error.message === "approved") {
            return res.status(400).send({
                error: "Order has been approved by user!",
            });
        } else {
            next(error);
        }
    }
};
