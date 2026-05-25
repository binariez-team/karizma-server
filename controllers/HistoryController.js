const History = require("../models/HistoryModel");

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

// fetch order items by order id
exports.fetchOrderItemsById = async (req, res, next) => {
    try {
        let ids = req.body;
        let results = await History.fetchOrderItemsById(ids);
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
        let ids = req.body;
        let results = await History.fetchReturnOrderItemsById(ids);
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
