const AdminHistory = require("../models/AdminHistoryModel");
const UserHistory = require("../models/UserHistoryModel");

exports.fetchDeliverHistory = async (req, res, next) => {
    try {
        const criteria = req.body;
        const { database_id } = req.user;
        let invoices = await AdminHistory.fetchDeliverHistory(
            criteria,
            database_id,
        );
        res.status(200).send(invoices);
    } catch (error) {
        next(error);
    }
};

exports.fetchMoneyTransferHistory = async (req, res, next) => {
    try {
        const criteria = req.body;
        const { database_id } = req.user;
        let invoices = await AdminHistory.fetchMoneyTransferHistory(
            database_id,
            criteria,
        );
        res.status(200).send(invoices);
    } catch (error) {
        next(error);
    }
};

// purchases
exports.fetchPurchaseHistory = async (req, res, next) => {
    try {
        const criteria = req.body;
        let supplies = await AdminHistory.fetchPurchaseHistory(criteria);
        res.status(200).send(supplies);
    } catch (error) {
        next(error);
    }
};

// one delivery's lines for the admin deliver list, fetched on demand (the list
// is header-only); scoped like that list: sent by this admin
exports.fetchDeliverItems = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const { order_id } = req.params;
        const items = await UserHistory.fetchDeliverItems(order_id, database_id, true);
        if (!items) {
            return res.status(404).send({ message: "Order not found" });
        }
        res.status(200).send(items);
    } catch (error) {
        next(error);
    }
};

// one purchase's lines, fetched on demand (the list is header-only)
exports.fetchPurchaseItems = async (req, res, next) => {
    try {
        const { order_id } = req.params;
        let items = await AdminHistory.fetchPurchaseItems(order_id);
        if (!items) {
            return res.status(404).send({ message: "Order not found" });
        }
        res.status(200).send(items);
    } catch (error) {
        next(error);
    }
};

exports.fetchSuppliersPaymentHistory = async (req, res, next) => {
    try {
        const database_id = req.user.database_id;
        let criteria = req.body;
        let payments = await AdminHistory.fetchSuppliersPaymentHistory(
            database_id,
            criteria,
        );
        res.status(200).send(payments);
    } catch (error) {
        next(error);
    }
};
