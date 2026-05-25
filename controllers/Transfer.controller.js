const Transfer = require("../models/TransferModel");

//get transfer accounts
exports.getTransferAccounts = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const accounts = await Transfer.getTransferAccounts(database_id);
        res.status(200).json(accounts);
    } catch (error) {
        next(error);
    }
};

// get all transfers
exports.getAll = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const criteria = req.body;
        const transfers = await Transfer.getAll(database_id, criteria);
        res.status(200).json(transfers);
    } catch (error) {
        next(error);
    }
};

// create transfer
exports.createTransfer = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const transferData = req.body;
        const transfer = await Transfer.create(database_id, transferData);
        res.status(200).json(transfer);
    } catch (error) {
        next(error);
    }
};

// update transfer
exports.updateTransfer = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const { transfer_id } = req.params;
        const transferData = req.body;
        const transfer = await Transfer.update(
            database_id,
            transfer_id,
            transferData,
        );
        res.status(200).json(transfer);
    } catch (error) {
        next(error);
    }
};

// delete transfer
exports.deleteTransfer = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const { transfer_id } = req.params;
        const transfer = await Transfer.delete(database_id, transfer_id);
        res.status(200).json(transfer);
    } catch (error) {
        next(error);
    }
};

// confirmTransfer
exports.confirmTransfer = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const { transfer_id } = req.params;
        const transfer = await Transfer.confirmTransfer(
            database_id,
            transfer_id,
        );
        res.status(200).json(transfer);
    } catch (error) {
        next(error);
    }
};
