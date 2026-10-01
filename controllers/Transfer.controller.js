const moment = require("moment-timezone");
const Transfer = require("../models/TransferModel");

// One answer for a missing id, another tenant's transfer, a deleted one or one the
// caller is on the wrong side of (only the sender edits/deletes, only the receiver
// confirms), so ids cannot be probed.
const TRANSFER_NOT_FOUND = { message: "Transfer not found." };
const TRANSFER_CONFIRMED = { message: "Transfer already confirmed" };
// Also covers the caller itself and anything the receiver list (GET /transfer/accounts)
// would not offer: a staff-only, deleted or unknown database.
const RECEIVER_NOT_FOUND = { message: "Receiver not found" };

// Ids come from the URL or the JSON body; mysql2 expands an object bound to `?` into
// `key = value` SQL, so only a positive integer is let through to the queries.
const toId = (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// The same expansion applies to the body values bound into SET/VALUES: an object
// amount would let the body write any column of the row (tenant, voucher, approval).
const isScalar = (value) =>
    typeof value === "string" || typeof value === "number";

// money_transfers.amount, the voucher total and the item debit/credit are
// DECIMAL(10,2), which keeps cents only: MySQL would store 0.004 as a 0.00 transfer
// and reject 99999999.995 as out of range.
const MAX_CENTS = 9999999999;

// Normalizes the transfer body in place; returns an error message, or null when it
// is valid. The receiver (to_database_id) is not checked here: create looks it up,
// update keeps the stored one.
const checkTransferBody = (data, { create }) => {
    // The edit dialog echoes amount back as mysql2's DECIMAL string ("12.50").
    // Checked and stored in cents, so what is written is what was validated. A
    // negative transfer would move money from the receiver to the sender.
    const amount = isScalar(data.amount) ? Number(data.amount) : NaN;
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || cents < 1 || cents > MAX_CENTS) {
        return "Invalid amount";
    }
    data.amount = cents / 100;

    const moneyAccount = isScalar(data.money_account)
        ? String(data.money_account)
        : null;
    if (!Transfer.MONEY_ACCOUNTS.includes(moneyAccount)) {
        return "Invalid money account";
    }
    data.money_account = moneyAccount;

    // A missing date has always meant "now" (moment(undefined)); anything else must
    // parse to a year DATETIME can hold, or the INSERT/UPDATE fails with a 500
    // (moment formats an unparseable value as "Invalid date").
    if (data.transfer_datetime == null) {
        data.transfer_datetime = undefined;
    } else {
        const when = isScalar(data.transfer_datetime)
            ? moment(data.transfer_datetime)
            : null;
        if (!when?.isValid() || when.year() < 1000 || when.year() > 9999) {
            return "Invalid date";
        }
    }

    // Only create reads customer_id (the item's partner); the dialog never sends it.
    if (create && data.customer_id != null) {
        data.customer_id = toId(data.customer_id);
        if (!data.customer_id) {
            return "Invalid customer";
        }
    }
    return null;
};

// Responses for the outcomes TransferModel refuses without writing anything.
const sendRefusal = (res, status) => {
    switch (status) {
        case Transfer.NOT_FOUND:
            return res.status(404).json(TRANSFER_NOT_FOUND);
        case Transfer.CONFIRMED:
            return res.status(409).json(TRANSFER_CONFIRMED);
        case Transfer.NO_VOUCHER:
            // Only reachable through damaged data: the sender can still delete it.
            return res.status(409).json({
                message:
                    "This transfer's journal entry is missing, the sender must delete it and send it again",
            });
        default:
            throw new Error(`Unexpected transfer outcome: ${status}`);
    }
};

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
        const invalid = checkTransferBody(transferData, { create: true });
        if (invalid) {
            return res.status(400).json({ message: invalid });
        }
        transferData.to_database_id = toId(transferData.to_database_id);
        const created =
            transferData.to_database_id &&
            (await Transfer.create(database_id, transferData));
        if (!created) {
            return res.status(404).json(RECEIVER_NOT_FOUND);
        }
        io.emit("transferAdded", transferData.to_database_id);
        res.status(200).json();
    } catch (error) {
        next(error);
    }
};

// update transfer
exports.updateTransfer = async (req, res, next) => {
    try {
        const io = req.io;
        const { database_id } = req.user;
        const transfer_id = toId(req.params.transfer_id);
        if (!transfer_id) {
            return res.status(404).json(TRANSFER_NOT_FOUND);
        }
        const transferData = req.body;
        const invalid = checkTransferBody(transferData, { create: false });
        if (invalid) {
            return res.status(400).json({ message: invalid });
        }
        const result = await Transfer.update(
            database_id,
            transfer_id,
            transferData,
        );
        if (result.status !== Transfer.OK) {
            return sendRefusal(res, result.status);
        }
        // The stored receiver is the one whose list must refresh; the body's
        // to_database_id is ignored (the receiver cannot be changed).
        io.emit("transferUpdated", result.to_database_id);
        res.status(200).json({ message: "Transfer updated successfully" });
    } catch (error) {
        next(error);
    }
};

// delete transfer
exports.deleteTransfer = async (req, res, next) => {
    try {
        const io = req.io;
        const { database_id } = req.user;
        const transfer_id = toId(req.params.transfer_id);
        if (!transfer_id) {
            return res.status(404).json(TRANSFER_NOT_FOUND);
        }
        const result = await Transfer.delete(database_id, transfer_id);
        if (result.status !== Transfer.OK) {
            return sendRefusal(res, result.status);
        }
        io.emit("transferDeleted", result.to_database_id);
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
        const transfer_id = toId(req.params.transfer_id);
        if (!transfer_id) {
            return res.status(404).json(TRANSFER_NOT_FOUND);
        }
        const result = await Transfer.confirmTransfer(database_id, transfer_id);
        if (result.status !== Transfer.OK) {
            return sendRefusal(res, result.status);
        }
        io.emit("transferConfirmed", result.socketData);
        res.status(200).json({
            message: "Transfer Confirmed !",
        });
    } catch (error) {
        next(error);
    }
};
