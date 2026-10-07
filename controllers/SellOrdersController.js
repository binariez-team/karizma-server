const SellOrders = require("../models/SellOrdersModel");
const { actorId } = require("../models/OrderActors");

// Every line of a sale must move a positive quantity. The model
// books `-quantity` as the SALE stock movement, so a negative line (e.g. a "-2*CODE"
// scan) would ADD stock and post a negative total; a zero line books nothing but
// still shows on the invoice. The clients block both — this is the server's own check.
const invalidQuantity = (items) =>
    Array.isArray(items) &&
    items.some((item) => {
        const qty = Number(item?.quantity);
        // whole units: the quantity columns are INT, so 0.4 would be stored as 0
        // while the line total is still computed from 0.4
        return !Number.isInteger(qty) || qty < 1;
    });

// The checkout's "Needs review" checkbox. Strict: true/1 flag the invoice, false/0
// or leaving it out (undefined/null) do not; anything else ("true", "yes", 2, {})
// is refused, so a malformed flag is never silently read either way.
// Returns true/false, or undefined when invalid.
const toReviewFlag = (value) => {
    if (value === undefined || value === null) return false;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    return undefined;
};
const INVALID_REVIEW_FLAG = { message: "Invalid needs_review value" };

// a route param that must be a positive integer id: digits only, so "1e3", "0x1f",
// "1.0" or "-1" are refused instead of being coerced by Number(). null when invalid.
const toParamId = (value) => {
    if (typeof value !== "string" || !/^[0-9]{1,16}$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
};

exports.addOrder = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const order = req.body.invoice;
        const payment = req.body.payment;
        const items = order.items;
        delete order.items;
        // An invoice converted from a saved quotation names it, so the quotation is
        // marked converted in the same transaction (see QuotationModel.markConverted).
        // Sent beside `invoice`; also taken off the invoice itself, where `SET ?`
        // would try to write a column sales_orders does not have.
        const quotation_id = req.body.quotation_id ?? order.quotation_id ?? null;
        delete order.quotation_id;
        if (invalidQuantity(items)) {
            return res
                .status(400)
                .send({ message: "Every item needs a whole quantity of 1 or more" });
        }
        // "Needs review": on the invoice (`invoice.needs_review`), or beside it like
        // quotation_id. Both are validated; if both are sent they must agree. The
        // model stamps the column from this value only (SellOrdersModel.stampReview).
        const flagOnInvoice = toReviewFlag(order.needs_review);
        const flagBeside = toReviewFlag(req.body.needs_review);
        if (flagOnInvoice === undefined || flagBeside === undefined) {
            return res.status(400).send(INVALID_REVIEW_FLAG);
        }
        const bothSent =
            order.needs_review != null && req.body.needs_review != null;
        if (bothSent && flagOnInvoice !== flagBeside) {
            return res.status(400).send(INVALID_REVIEW_FLAG);
        }
        const needs_review = flagOnInvoice || flagBeside;

        order.database_id = database_id;

        const result = await SellOrders.addOrder(
            order,
            items,
            database_id,
            payment,
            actorId(req.user),
            quotation_id,
            needs_review,
        );
        const new_order = await SellOrders.getAddedOrderById(
            result.order,
            database_id,
        );
        // only when a quotation was named: whether it is now linked to this invoice.
        // The sale is already committed here, so an empty re-read must answer exactly
        // like a sale without quotation_id (201) instead of throwing into a 500.
        if (quotation_id !== null && new_order) {
            new_order.quotation_converted = result.quotation_converted;
        }
        res.status(201).json(new_order);
    } catch (error) {
        next(error);
    }
};
exports.editOrder = async (req, res, next) => {
    try {
        // A cash invoice carries its tender split alongside the invoice. Accept the new
        // { invoice, payment } envelope, and fall back to the legacy flat body so an
        // older client keeps working for debt invoices.
        const order = req.body.invoice ?? req.body;
        const payment = req.body.payment ?? null;
        const items = order.items;
        delete order.items;
        if (invalidQuantity(items)) {
            return res
                .status(400)
                .send({ message: "Every item needs a whole quantity of 1 or more" });
        }
        const { database_id } = req.user;

        const order_id = await SellOrders.editOrder(
            order,
            items,
            database_id,
            payment,
            actorId(req.user),
        );
        const new_order = await SellOrders.getAddedOrderById(
            order_id,
            database_id,
        );
        res.status(201).json(new_order);
    } catch (error) {
        next(error);
    }
};

// current cash/whish split of an invoice, so the edit screen can pre-fill it
exports.getOrderPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const result = await SellOrders.getOrderPayment(
            req.params.id,
            database_id,
        );
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};
exports.deleteOrder = async (req, res, next) => {
    try {
        const order_id = req.params.id;
        const { database_id } = req.user;
        await SellOrders.deleteOrder(order_id, database_id);
        res.status(200).json({ message: "Order deleted successfully" });
    } catch (error) {
        next(error);
    }
};

// ############################ review queue ##################################################
// Owner only: the routes put `owner` (middleware/auth) in front of these, so staff get
// 403 before anything is read. Everything is scoped to the caller's database_id.
// An unknown id, another database's invoice, a deleted one, one that was never
// flagged and a malformed id all get the same 404.

const REVIEW_NOT_FOUND = { message: "Invoice not found" };
const REVIEW_STATUSES = new Set(["pending", "reviewed", "all"]);

// GET /sell-orders/review/count — { count } of invoices waiting for review
exports.reviewCount = async (req, res, next) => {
    try {
        const count = await SellOrders.countPendingReview(req.user.database_id);
        res.status(200).json({ count });
    } catch (error) {
        next(error);
    }
};

// POST /sell-orders/review/search — { status?: 'pending' | 'reviewed' | 'all' }
exports.reviewSearch = async (req, res, next) => {
    try {
        const status = req.body?.status ?? "pending";
        if (!REVIEW_STATUSES.has(status)) {
            return res.status(400).json({ message: "Invalid review status" });
        }
        const rows = await SellOrders.searchReview(req.user.database_id, status);
        res.status(200).json(rows);
    } catch (error) {
        next(error);
    }
};

// PATCH /sell-orders/review/:order_id — mark reviewed (idempotent)
exports.markReviewed = async (req, res, next) => {
    try {
        const order_id = toParamId(req.params.order_id);
        if (!order_id) return res.status(404).json(REVIEW_NOT_FOUND);
        // the reviewer is recorded from the token; a token without a usable
        // user_id cannot sign a review
        const reviewer = actorId(req.user);
        if (!reviewer) {
            return res
                .status(403)
                .json({ message: "Only the account owner can do this" });
        }
        const row = await SellOrders.markReviewed(
            order_id,
            req.user.database_id,
            reviewer,
        );
        if (!row) return res.status(404).json(REVIEW_NOT_FOUND);
        res.status(200).json(row);
    } catch (error) {
        next(error);
    }
};
