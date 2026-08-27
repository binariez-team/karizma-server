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

exports.fetchReceivedDeliveries = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        let criteria = req.body;
        let invoices = await UserHistory.fetchReceivedDeliveries(
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
        const { id } = req.body;

        // The receiving tenant comes from the caller's token, never the request body.
        // database_id and admin_id used to be taken straight from req.body and were
        // never checked against the order, so any authenticated caller could approve
        // somebody else's pending delivery into their own pool — stock, weighted-average
        // cost merge and all — with the opening cost basis read from a database they do
        // not own. The sending tenant is now derived from the order itself.
        const { database_id } = req.user;

        let result = await UserHistory.approvePendingInvoice(id, database_id);

        if (result.status) {
            if (result.status === "error") {
                return res.status(400).send(result);
            }
        }

        const [database] = await User.getDatabaseById(database_id);

        // this is to inform admin that user approved invoice
        io.emit("deliverCompleted", {
            user: database.database_name,
            id: id,
        });
        res.status(200).send(result);
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
