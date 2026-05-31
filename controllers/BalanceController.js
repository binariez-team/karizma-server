const Balance = require("../models/BalanceModel");

//get user balance
exports.getBalance = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const balance = await Balance.getBalance(database_id);
        res.status(200).send(balance);
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
