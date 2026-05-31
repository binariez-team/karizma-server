const pool = require("../config/database");
const moment = require("moment-timezone");
const Account = require("./AccountsModel");

class Transfer {
    // get accounts suitable for transfer
    static async getTransferAccounts(database_id) {
        const query = `SELECT 
        d.*,
        CONCAT(u.first_name, ' ', u.last_name) AS full_name
        FROM user_database d
        INNER JOIN users u ON d.database_id = u.database_id
        WHERE u.user_type != 'staff' AND u.is_deleted = 0 AND u.database_id != ?`;
        const [rows] = await pool.query(query, [database_id]);
        return rows;
    }

    // get all money transfers for a specific database_id
    static async getAll(database_id, criteria) {
        let sql = `
        SELECT 
            mt.transfer_id,
            mt.transfer_number,
            mt.transfer_datetime,
            mt.amount,
            mt.money_account,
            mt.from_database_id,
            mt.to_database_id,
            mt.is_approved,

            -- Names
            db_from.database_name AS from_database_name,
            db_to.database_name   AS to_database_name,

            -- Direction
            CASE 
                WHEN mt.from_database_id = ? THEN 'sent'
                ELSE 'received'
            END AS direction,

            -- Other party (very useful)
            CASE 
                WHEN mt.from_database_id = ? THEN db_to.database_name
                ELSE db_from.database_name
            END AS other_party_name

        FROM money_transfers mt

        LEFT JOIN user_database db_from 
            ON db_from.database_id = mt.from_database_id

        LEFT JOIN user_database db_to 
            ON db_to.database_id = mt.to_database_id

        WHERE 
            (mt.from_database_id = ? OR mt.to_database_id = ?)
            AND mt.is_deleted = 0
    `;

        const params = [
            database_id, // for direction
            database_id, // for other_party_name
            database_id, // WHERE
            database_id, // WHERE
        ];

        if (criteria.transfer_number) {
            sql += ` AND mt.transfer_number LIKE ?`;
            params.push(`%${criteria.transfer_number}%`);
        }

        if (criteria.to_database_id) {
            sql += ` AND mt.to_database_id = ?`;
            params.push(criteria.to_database_id);
        }

        if (criteria.start_date) {
            sql += ` AND DATE(mt.transfer_datetime) >= ?`;
            params.push(moment(criteria.start_date).format("YYYY-MM-DD"));
        }

        if (criteria.end_date) {
            sql += ` AND DATE(mt.transfer_datetime) <= ?`;
            params.push(moment(criteria.end_date).format("YYYY-MM-DD"));
        }

        sql += ` ORDER BY mt.transfer_datetime DESC`;

        const [rows] = await pool.execute(sql, params);

        return rows;
    }

    // create transfer money
    static async create(database_id, transferData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            transferData.transfer_datetime = moment(
                transferData.transfer_datetime,
            ).format(`YYYY-MM-DD ${moment().format("HH:mm:ss")}`);

            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'TRA%'`,
            );

            let payment_number = `TRA${number.toString().padStart(4, "0")}`;

            //get receiver account name
            let [[receiver]] = await connection.query(
                `SELECT first_name FROM users WHERE database_id = ?`,
                [transferData.to_database_id],
            );

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers ( database_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                payment_number,
                transferData.transfer_datetime,
                `Transfer`,
                transferData.amount,
            ]);

            const [selectedMoneyAccount] = await Account.getIdByAccountNumber(
                transferData.money_account,
            );

            // from database
            const fromDatabase = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: transferData.transfer_datetime,
                account_id_fk: selectedMoneyAccount.id,
                partner_id_fk: transferData.customer_id,
                debit: 0,
                credit: transferData.amount,
                notes: `To ${receiver.first_name} (unconfirmed)`,
            };
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                fromDatabase,
            );

            // NEW CODE
            const TransferQuery = `INSERT INTO money_transfers (journal_id, transfer_number, transfer_datetime, amount, money_account, from_database_id, to_database_id, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`;
            await connection.query(TransferQuery, [
                journal_voucher.insertId,
                payment_number,
                transferData.transfer_datetime,
                transferData.amount,
                transferData.money_account,
                database_id,
                transferData.to_database_id,
            ]);

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // update transfer money
    static async update(database_id, transfer_id, transferData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // check if already confirmed
            const [[oldTransfer]] = await connection.query(
                `SELECT * FROM money_transfers WHERE transfer_id = ?`,
                [transfer_id],
            );

            if (oldTransfer.is_approved) {
                throw new Error("Transfer already confirmed");
            }

            if (oldTransfer.from_database_id != database_id) {
                throw new Error("You can't update this transfer");
            }

            moment.tz.setDefault("Asia/Beirut");
            transferData.transfer_datetime = moment(
                transferData.transfer_datetime,
            ).format(`YYYY-MM-DD HH:mm:ss`);

            // update money_transfer record
            const updateTransferQuery = `UPDATE money_transfers SET transfer_datetime = ?, amount = ?, money_account = ? WHERE transfer_id = ?`;
            await connection.query(updateTransferQuery, [
                transferData.transfer_datetime,
                transferData.amount,
                transferData.money_account,
                transfer_id,
            ]);

            // update journal voucher
            const updateJournalVoucherQuery = `UPDATE journal_vouchers SET journal_date = ?, total_value = ? WHERE journal_id = ?`;
            await connection.query(updateJournalVoucherQuery, [
                transferData.transfer_datetime,
                transferData.amount,
                oldTransfer.journal_id,
            ]);

            //get receiver account name
            let [[receiver]] = await connection.query(
                `SELECT first_name FROM users WHERE database_id = ?`,
                [transferData.to_database_id],
            );

            const [selectedMoneyAccount] = await Account.getIdByAccountNumber(
                transferData.money_account,
            );

            // update journal items
            const updateJournalItemsQuery = `UPDATE journal_items SET journal_date = ?, account_id_fk = ?, credit = ?, notes = ? WHERE journal_id_fk = ? AND database_id = ?`;
            await connection.query(updateJournalItemsQuery, [
                transferData.transfer_datetime,
                selectedMoneyAccount.id,
                transferData.amount,
                `To ${receiver.first_name}`,
                oldTransfer.journal_id,
                database_id,
            ]);

            await connection.commit();

            return { message: "Transfer updated successfully" };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // delete transfer
    static async delete(database_id, transfer_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // check if already confirmed
            let [[oldTransfer]] = await connection.query(
                `SELECT * FROM money_transfers WHERE transfer_id = ?`,
                [transfer_id],
            );

            if (oldTransfer.is_approved) {
                throw new Error("Transfer already confirmed");
            }

            // delete transfer
            const deleteTransferQuery = `DELETE FROM money_transfers WHERE transfer_id = ?`;
            await connection.query(deleteTransferQuery, [transfer_id]);

            // delete journal voucher
            const deleteJournalVoucherQuery = `DELETE FROM journal_vouchers WHERE journal_id = ?`;
            await connection.query(deleteJournalVoucherQuery, [
                oldTransfer.journal_id,
            ]);

            // delete journal items
            const deleteJournalItemsQuery = `DELETE FROM journal_items WHERE journal_id_fk = ?`;
            await connection.query(deleteJournalItemsQuery, [
                oldTransfer.journal_id,
            ]);

            await connection.commit();

            return oldTransfer.to_database_id;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // confirm transfer
    static async confirmTransfer(database_id, transfer_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // check if already confirmed
            let [[oldTransfer]] = await connection.query(
                `SELECT * FROM money_transfers WHERE transfer_id = ?`,
                [transfer_id],
            );

            if (!oldTransfer) {
                throw new Error("Transfer not found");
            }
            if (oldTransfer.is_approved) {
                throw new Error("Transfer already confirmed");
            }

            if (oldTransfer.to_database_id !== database_id) {
                throw new Error("You can't confirm this transfer");
            }

            // get transfer data
            let [[transferData]] = await connection.query(
                `SELECT * FROM money_transfers WHERE transfer_id = ?`,
                [transfer_id],
            );

            // set is_approved to 1
            const TransferQuery = `UPDATE money_transfers SET is_approved = 1 WHERE transfer_id = ? AND from_database_id = ?`;
            await connection.query(TransferQuery, [
                transferData.transfer_id,
                transferData.from_database_id,
            ]);

            const [moneyAccount] = await Account.getIdByAccountNumber(
                transferData.money_account,
            );

            //get sender account name
            let [[sender]] = await connection.query(
                `SELECT first_name FROM users WHERE database_id = ?`,
                [transferData.from_database_id],
            );

            //get receiver account name
            let [[receiver]] = await connection.query(
                `SELECT first_name FROM users WHERE database_id = ?`,
                [transferData.to_database_id],
            );

            // update journal item note
            const updateNoteQuery = `UPDATE journal_items SET notes = ? WHERE journal_id_fk = ? AND database_id = ?`;

            await connection.query(updateNoteQuery, [
                `To ${receiver.first_name}`,
                transferData.journal_id,
                transferData.from_database_id,
            ]);

            // insert new journal item for receiver
            const toDatabase = {
                database_id: transferData.to_database_id,
                journal_id_fk: transferData.journal_id,
                journal_date: transferData.transfer_datetime,
                account_id_fk: moneyAccount.id,
                debit: transferData.amount,
                credit: 0,
                notes: `From ${sender.first_name}`,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                toDatabase,
            );

            await connection.commit();

            return {
                name: receiver.first_name,
                database_id: transferData.from_database_id,
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = Transfer;
