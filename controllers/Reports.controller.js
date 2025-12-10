const Reports = require("../models/ReportModel");

// exports.getTotalSales = async (req, res, next) => {
// 	try {
// 		const { start, end } = req.params;
// 		const user_id = req.user.user_id;
// 		const result = await Reports.getTotalSales(user_id, start, end);
// 		res.status(200).json(result);
// 	} catch (error) {
// 		next(error);
// 	}
// };

exports.getStockValue = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const result = await Reports.getStockValue(database_id);
        res.status(200).send(result);
    } catch (error) {
        next(error);
    }
};

// ###################################### New Reports #####################################

exports.getRevenue = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getRevenue(start, end, database_id);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.getReturns = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getReturns(start, end, database_id);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.getDisposes = async (req, res, next) => {
    try {
        // getDisposes
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getDisposes(start, end, database_id);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

exports.getTotalOrders = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getTotalOrders(start, end, database_id);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.getDebts = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getDebts(start, end, database_id);
        res.status(200).send(result);
    } catch (error) {
        next(error);
    }
};

// get customer payments
exports.getCustomerPayments = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getCustomerPayments(
            start,
            end,
            database_id
        );
        res.status(200).send(result);
    } catch (error) {
        next(error);
    }
};

exports.getCashBalance = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getCashBalance(start, end, database_id);
        res.status(200).send(result);
    } catch (error) {
        next(error);
    }
};

exports.getManualCashTransactions = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getManualCashTransactions(
            start,
            end,
            database_id
        );
        res.status(200).send(result);
    } catch (error) {
        next(error);
    }
};

exports.getExpenses = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getExpenses(start, end, database_id);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.getSupplierPayments = async (req, res, next) => {
    try {
        const { start, end } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getSupplierPayments(
            start,
            end,
            database_id
        );
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.getTopSales = async (req, res, next) => {
    try {
        const { start, end, id } = req.params;
        const { database_id } = req.user;
        const result = await Reports.getTopSales(start, end, id, database_id);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.getTopCategories = async (req, res, next) => {
    const { start, end } = req.params;
    const { database_id } = req.user;
    try {
        let topCategories = await Reports.getTopCategories(
            start,
            end,
            database_id
        );
        res.status(200).send(topCategories);
    } catch (error) {
        next(error);
    }
};
