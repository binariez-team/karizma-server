const UserHistory = require("../models/UserHistoryModel");
const User = require("../models/UserModel");

exports.fetchDeliverHistory = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        let criteria = req.body;
        let invoices = await UserHistory.fetchDeliverHistory(
            database_id,
            criteria
        );
        res.status(200).send(invoices);
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

exports.approvePendingInvoice = async (req, res, next) => {
    try {
        const io = req.io;
        const { id, database_id, admin_id } = req.body;

        let invoices = await UserHistory.approvePendingInvoice(
            id,
            database_id,
            admin_id
        );
        const [database] = await User.getDatabaseById(database_id);

        console.log(database);

        // this is to inform admin that user approved invoice
        io.emit("deliverCompleted", {
            user: database.database_name,
            id: id,
        });
        res.status(200).send(invoices);
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
