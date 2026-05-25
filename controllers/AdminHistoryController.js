const AdminHistory = require("../models/AdminHistoryModel");

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
