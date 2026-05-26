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
        const io = req.io;
        const { database_id } = req.user;
        const transferData = req.body;
        const transfer = await Transfer.create(database_id, transferData);
        io.emit("transferAdded", transferData.to_database_id);
        res.status(200).json(transfer);
    } catch (error) {
        next(error);
    }
};

// update transfer
exports.updateTransfer = async (req, res, next) => {
    try {
        const io = req.io;
        const { database_id } = req.user;
        const { transfer_id } = req.params;
        const transferData = req.body;
        const transfer = await Transfer.update(
            database_id,
            transfer_id,
            transferData,
        );
        io.emit("transferUpdated", transferData.to_database_id);
        res.status(200).json(transfer);
    } catch (error) {
        next(error);
    }
};

// delete transfer
exports.deleteTransfer = async (req, res, next) => {
    try {
        const io = req.io;
        const { database_id } = req.user;
        const { transfer_id } = req.params;
        const to_database_id = await Transfer.delete(database_id, transfer_id);
        io.emit("transferDeleted", to_database_id);
        res.status(200).json({
            message: "Transfer Deleted !",
        });
    } catch (error) {
        next(error);
    }
};

// confirmTransfer
exports.confirmTransfer = async (req, res, next) => {
    try {
        const io = req.io;
        const { database_id } = req.user;
        const { transfer_id } = req.params;
        const socketData = await Transfer.confirmTransfer(
            database_id,
            transfer_id,
        );
        io.emit("transferConfirmed", socketData);
        res.status(200).json({
            message: "Transfer Confirmed !",
        });
    } catch (error) {
        next(error);
    }
};
