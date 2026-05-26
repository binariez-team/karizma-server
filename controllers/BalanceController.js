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

//transfer money
// exports.transferMoney = async (req, res, next) => {
//     const { database_id } = req.user;
//     const paymentData = req.body;

//     const io = req.io;

//     try {
//         const transfer = await Balance.transferMoney(database_id, paymentData);

//         io.emit("transferAdded", paymentData.to_database_id);
//         res.status(200).json(transfer);
//     } catch (error) {
//         next(error);
//     }
// };

//update transfer
exports.updateTransfer = async (req, res, next) => {
    const { database_id } = req.user;
    const paymentData = req.body;
    try {
        const transfer = await Balance.updateTransfer(database_id, paymentData);
        res.status(200).json(transfer);
    } catch (error) {
        next(error);
    }
};

//delete transfer
exports.deleteTransfer = async (req, res, next) => {
    const { database_id } = req.user;
    const journal_id = req.params.id;
    try {
        const transfer = await Balance.deleteTransfer(database_id, journal_id);
        res.status(200).json(transfer);
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
        const { start, end } = req.params;
        const results = await Balance.getCashTransactions(
            start,
            end,
            database_id,
        );
        res.status(200).send(results);
    } catch (error) {
        next(error);
    }
};

// correct balance
exports.correctBalance = async (req, res, next) => {};
