const History = require("../models/HistoryModel");
const Customer = require("../models/CustomersModel");

const INVALID_ORDER_IDS = { message: "Invalid order ids" };
// Statements posts one id per statement row (invoices and returns mixed). Far
// above any one customer's statement, and the default 100kb JSON body cannot
// carry many more ids anyway.
const MAX_ORDER_IDS = 10000;

// The details bodies are bound to `IN (?)`, where mysql2 expands an object
// into `key = value` SQL, so only a list of positive integers (numbers or
// numeric strings) gets through. Returns the deduped ids, or null when invalid.
const toOrderIds = (body) => {
    if (!Array.isArray(body) || body.length > MAX_ORDER_IDS) return null;
    const ids = new Set();
    for (const value of body) {
        const id =
            typeof value === "string" || typeof value === "number"
                ? Number(value)
                : NaN;
        if (!Number.isSafeInteger(id) || id < 1) return null;
        ids.add(id);
    }
    return [...ids];
};

// A route param that must be a positive integer id. Digits only, so "1e3",
// "0x1f", "1.0", " 7" or "-1" are rejected instead of being coerced by Number().
// Returns the id, or null when invalid.
const toParamId = (value) => {
    if (typeof value !== "string" || !/^[0-9]{1,16}$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
};

// product history
exports.getProductHistoryById = async (req, res, next) => {
    try {
        const product_id = req.params.id;
        const database_id = req.user.database_id;
        const history = await History.getProductHistoryById(
            product_id,
            database_id,
        );
        res.status(200).send(history);
    } catch (error) {
        next(error);
    }
};

// a customer's last 5 purchases of one product (sell / return "recent purchases")
exports.fetchRecentPurchases = async (req, res, next) => {
    try {
        const product_id = toParamId(req.params.product_id);
        const customer_id = toParamId(req.params.customer_id);
        if (!product_id || !customer_id) {
            return res
                .status(400)
                .json({ message: "Invalid product or customer id" });
        }
        const { database_id } = req.user;
        // Only a live customer of the caller's database. Another database's,
        // a deleted one, a supplier or an unknown id all get the same 404, so
        // the endpoint cannot be used to probe account ids.
        const customer = await Customer.getCustomerByIdAndUserId(
            database_id,
            customer_id,
        );
        if (!customer) {
            return res.status(404).send({ message: "Customer not found" });
        }
        const rows = await History.fetchRecentPurchases(
            product_id,
            customer_id,
            database_id,
        );
        res.status(200).send(rows);
    } catch (error) {
        next(error);
    }
};

// fetch order items by order id
exports.fetchOrderItemsById = async (req, res, next) => {
    try {
        const ids = toOrderIds(req.body);
        if (!ids) return res.status(400).json(INVALID_ORDER_IDS);
        // `IN ()` is a SQL error
        if (!ids.length) return res.status(200).send([]);
        let results = await History.fetchOrderItemsById(
            ids,
            req.user.database_id,
        );
        res.status(200).send(results);
    } catch (error) {
        next(error);
    }
};

// sales
exports.fetchSalesHistory = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        let criteria = req.body;
        let invoices = await History.fetchSalesHistory(database_id, criteria);
        res.status(200).send(invoices);
    } catch (error) {
        next(error);
    }
};

// lines of one sales invoice, fetched on demand by the history screen
exports.fetchSalesOrderItems = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const items = await History.fetchSalesOrderItems(
            req.params.order_id,
            database_id,
        );
        if (!items) {
            return res.status(404).send({ message: "Order not found" });
        }
        res.status(200).send(items);
    } catch (error) {
        next(error);
    }
};

// fetch products history
exports.fetchProductsSalesHistory = async (req, res, next) => {
    try {
        const database_id = req.user.database_id;
        const criteria = req.body;

        const data = await History.fetchProductsSalesHistory(
            database_id,
            criteria,
        );
        res.status(200).send(data);
    } catch (error) {
        next(error);
    }
};

// fetch return order items by id
exports.fetchReturnOrderItemsById = async (req, res, next) => {
    try {
        const ids = toOrderIds(req.body);
        if (!ids) return res.status(400).json(INVALID_ORDER_IDS);
        if (!ids.length) return res.status(200).send([]);
        let results = await History.fetchReturnOrderItemsById(
            ids,
            req.user.database_id,
        );
        res.status(200).send(results);
    } catch (error) {
        next(error);
    }
};

exports.fetchPaymentHistory = async (req, res, next) => {
    try {
        const database_id = req.user.database_id;
        let criteria = req.body;
        let payments = await History.fetchPaymentHistory(database_id, criteria);
        res.status(200).send(payments);
    } catch (error) {
        next(error);
    }
};

exports.fetchReturnHistory = async (req, res, next) => {
    try {
        const database_id = req.user.database_id;
        const criteria = req.body;
        let returns = await History.fetchReturnHistory(database_id, criteria);
        res.status(200).send(returns);
    } catch (error) {
        next(error);
    }
};

// lines of one return, fetched on demand by the history screen
exports.fetchReturnOrderItems = async (req, res, next) => {
    try {
        const database_id = req.user.database_id;
        const items = await History.fetchReturnOrderItems(
            req.params.order_id,
            database_id,
        );
        if (!items) {
            return res.status(404).send({ message: "Order not found" });
        }
        res.status(200).send(items);
    } catch (error) {
        next(error);
    }
};

exports.fetchDisposeHistory = async (req, res, next) => {
    try {
        const database_id = req.user.database_id;
        let criteria = req.body;
        let disposals = await History.fetchDisposeHistory(
            database_id,
            criteria,
        );
        res.status(200).send(disposals);
    } catch (error) {
        next(error);
    }
};

exports.fetchDisposeItemsHistory = async (req, res, next) => {
    try {
        const database_id = req.user.database_id;
        const criteria = req.body;
        const data = await History.fetchDisposeItemsHistory(database_id, criteria);
        res.status(200).send(data);
    } catch (error) {
        next(error);
    }
};
