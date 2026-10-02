const moment = require("moment-timezone");
const UserHistory = require("../models/UserHistoryModel");
const User = require("../models/UserModel");

const isScalar = (value) =>
    typeof value === "string" || typeof value === "number";

// deliver_orders.invoice_number is varchar(255): a longer term can't match
const INVOICE_MAX_LENGTH = 255;
// largest page a deliver search returns (the client sends no limit: 100)
const MAX_LIMIT = 500;

// limit/offset: absent means the default; otherwise an integer in [min, max],
// else null
const toPaging = (value, fallback, min, max) => {
    if (value == null || value === "") return fallback;
    const n = isScalar(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};

// Every deliver search criterion is bound to `?`, where mysql2 expands an
// object/array into SQL ({a:1} → `a` = 1), so a crafted value could drop or
// break a filter, or 500 the LIMIT. Checked here before any query, for the
// Sent/Received searches and the admin deliver search (AdminHistoryController).
// Returns { criteria } normalized, or { error } for a 400. Clear in older
// client bundles posted no body at all, hence the spread of a missing body.
function deliverCriteria(body) {
    const criteria = { ...body };

    // a database_id (recipient on Sent / admin, sender on Received)
    if (criteria.user_id != null && criteria.user_id !== "") {
        const id = isScalar(criteria.user_id) ? Number(criteria.user_id) : NaN;
        if (!Number.isSafeInteger(id) || id < 1) {
            return { error: "Invalid user" };
        }
        criteria.user_id = id;
    }

    // a trimmed string; blank means no filter (the models match it partially)
    const invoice = criteria.invoice_number;
    if (invoice != null && invoice !== "") {
        const term = isScalar(invoice) ? String(invoice).trim() : null;
        // counted in characters, as varchar is
        if (term == null || [...term].length > INVOICE_MAX_LENGTH) {
            return { error: "Invalid invoice number" };
        }
        criteria.invoice_number = term;
    }

    criteria.limit = toPaging(criteria.limit, 100, 1, MAX_LIMIT);
    criteria.offset = toPaging(criteria.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    if (criteria.limit == null || criteria.offset == null) {
        return { error: "Invalid paging" };
    }

    // The models format these with moment(): only an ISO date/datetime string
    // (the client's yyyy-MM-dd, older bundles' "yyyy-MM-dd HH:mm:ss") or epoch
    // ms, in DATE's year range, so nothing reaches SQL as "Invalid date".
    for (const key of ["start_date", "end_date", "order_date"]) {
        const value = criteria[key];
        if (value == null || value === "") continue;
        const day =
            typeof value === "string"
                ? moment(value, moment.ISO_8601, true)
                : typeof value === "number"
                ? moment(value)
                : null;
        if (!day?.isValid() || day.year() < 1000 || day.year() > 9999) {
            return { error: "Invalid date" };
        }
        // passed on as the day itself: the models skip a falsy date, and
        // epoch 0 is a valid one (1970-01-01) that would drop the filter
        criteria[key] = day.format("YYYY-MM-DD");
    }
    return { criteria };
}
exports.deliverCriteria = deliverCriteria;

exports.fetchDeliverHistory = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const { criteria, error } = deliverCriteria(req.body);
        if (error) {
            return res.status(400).send({ message: error });
        }
        let invoices = await UserHistory.fetchDeliverHistory(
            database_id,
            criteria
        );
        res.status(200).send(invoices);
    } catch (error) {
        next(error);
    }
};

exports.fetchReceivedDeliveries = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const { criteria, error } = deliverCriteria(req.body);
        if (error) {
            return res.status(400).send({ message: error });
        }
        let invoices = await UserHistory.fetchReceivedDeliveries(
            database_id,
            criteria
        );
        res.status(200).send(invoices);
    } catch (error) {
        next(error);
    }
};

// { database_id, database_name } of everyone who sent the caller a delivery
// on the received list (other users or the admin tenant), for its user filter
exports.fetchReceivedDeliverySenders = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const senders = await UserHistory.fetchReceivedDeliverySenders(
            database_id
        );
        res.status(200).send(senders);
    } catch (error) {
        next(error);
    }
};

exports.fetchPendingInvoices = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        let invoices = await UserHistory.fetchPendingInvoices(database_id);
        res.status(200).send(invoices);
    } catch (error) {
        next(error);
    }
};

// lines of one delivery, fetched on demand (the lists return headers only)
exports.fetchDeliverItems = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const { order_id } = req.params;
        const items = await UserHistory.fetchDeliverItems(order_id, database_id);

        // same answer for "missing", "deleted" and "not yours" so ids can't be probed
        if (!items) {
            return res.status(404).send({ message: "Order not found" });
        }
        res.status(200).send(items);
    } catch (error) {
        next(error);
    }
};

exports.approvePendingInvoice = async (req, res, next) => {
    try {
        const io = req.io;
        const { id } = req.body;

        // The receiving tenant comes from the caller's token, never the request body.
        // database_id and admin_id used to be taken straight from req.body and were
        // never checked against the order, so any authenticated caller could approve
        // somebody else's pending delivery into their own pool — stock, weighted-average
        // cost merge and all — with the opening cost basis read from a database they do
        // not own. The sending tenant is now derived from the order itself.
        const { database_id } = req.user;

        let result = await UserHistory.approvePendingInvoice(id, database_id);

        if (result.status) {
            if (result.status === "error") {
                return res.status(400).send(result);
            }
        }

        const [database] = await User.getDatabaseById(database_id);

        // this is to inform admin that user approved invoice
        io.emit("deliverCompleted", {
            user: database.database_name,
            id: id,
        });
        res.status(200).send(result);
    } catch (error) {
        next(error);
    }
};

exports.fetchUserMoneyTransferHistory = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const criteria = req.body;
        let transfers = await UserHistory.fetchUserMoneyTransferHistory(
            database_id,
            criteria
        );
        res.status(200).send(transfers);
    } catch (error) {
        next(error);
    }
};
