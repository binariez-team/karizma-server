const pool = require("../config/database");
const Account = require("./AccountsModel");
const moment = require("moment-timezone");

class BalanceModel {
    // get balance
    static async getBalance(database_id) {
        const [_531] = await Account.getIdByAccountNumber("531");
        const query = `SELECT COALESCE(sum(debit) - sum(credit),0) AS balance
        FROM journal_items ji
        where ji.is_deleted = 0
        AND ji.account_id_fk = ?
		AND ji.database_id = ?`;

        const [[rows]] = await pool.query(query, [_531.id, database_id]);

        return rows;
    }

    static async getBalanceByUserId(userId) {
        const [_531] = await Account.getIdByAccountNumber("531");
        const query = `SELECT COALESCE(sum(debit) - sum(credit),0) AS balance 
        FROM journal_items ji
        where ji.is_deleted = 0
        AND ji.account_id_fk = ?
        AND ji.database_id = ?;`;
        const [[rows]] = await pool.query(query, [_531.id, userId]);

        return rows;
    }

    static async getAllUsersBalance() {
        const [_531] = await Account.getIdByAccountNumber("531");
        const query = `SELECT u.database_id , COALESCE(sum(ji.debit) - sum(ji.credit),0) AS balance 
            FROM users u
            LEFT JOIN journal_items ji  ON u.database_id = ji.database_id
            AND ji.is_deleted = 0
            AND ji.account_id_fk = ?
            GROUP BY u.database_id;`;
        const [rows] = await pool.query(query, [_531.id]);
        return rows;
    }

    //transfer money
    static async transferMoney(database_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            paymentData.payment_date = moment(paymentData.payment_date).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );

            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'TRA%'`,
            );

            let payment_number = `TRA${number.toString().padStart(4, "0")}`;

            //get receiver account name
            let [[receiver]] = await connection.query(
                `SELECT first_name FROM users WHERE database_id = ?`,
                [paymentData.to_database_id],
            );

            //get sender account name
            let [[sender]] = await connection.query(
                `SELECT first_name FROM users WHERE database_id = ?`,
                [database_id],
            );

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers ( database_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                payment_number,
                paymentData.payment_date,
                `Transfer`,
                paymentData.amount,
            ]);

            let [_531] = await Account.getIdByAccountNumber("531");

            const firstItem = {
                database_id: paymentData.to_database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: paymentData.payment_date,
                account_id_fk: _531.id,
                partner_id_fk: null,
                debit: paymentData.amount,
                credit: 0,
                notes: `From ${sender.first_name}`,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                firstItem,
            );

            const secondItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: paymentData.payment_date,
                account_id_fk: _531.id,
                partner_id_fk: paymentData.customer_id,
                debit: 0,
                credit: paymentData.amount,
                notes: `To ${receiver.first_name}`,
            };
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                secondItem,
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    static async updateTransfer(database_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            paymentData.payment_date = moment(paymentData.payment_date).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );

            //insert to vouchers and journal_items
            let query = `UPDATE journal_vouchers SET total_value = ? WHERE journal_id = ? and database_id = ?`;
            const [journal_voucher] = await connection.query(query, [
                // paymentData.payment_date,
                paymentData.amount,
                paymentData.journal_id,
                database_id,
            ]);

            let [_531] = await Account.getIdByAccountNumber("531");

            await connection.query(
                `UPDATE journal_items SET debit = ? WHERE journal_id_fk = ? AND database_id != ?`,
                [paymentData.amount, paymentData.journal_id, database_id],
            );

            await connection.query(
                `UPDATE journal_items SET credit = WHERE journal_id_fk = ? AND database_id = ?`,
                [paymentData.amount, paymentData.journal_id, database_id],
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    static async deleteTransfer(database_id, journal_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            let [journal_items] = await connection.query(
                `SELECT journal_item_id FROM journal_items ji
                inner join journal_vouchers jv 
                ON jv.journal_id = ji.journal_id_fk 
                WHERE journal_id_fk = ? AND jv.database_id = ?`,
                [journal_id, database_id],
            );
            journal_items = journal_items.map((item) => item.journal_item_id);

            await connection.query(
                `UPDATE journal_items SET is_deleted = 1 WHERE journal_item_id in (?)`,
                [journal_items],
            );

            await connection.query(
                `UPDATE journal_vouchers SET is_deleted = 1 WHERE journal_id = ? AND database_id = ?`,
                [journal_id, database_id],
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    static async getTransferAccounts(database_id) {
        const query = `SELECT d.*, CONCAT(u.first_name, ' ', u.last_name) AS full_name FROM user_database d
        INNER JOIN users u ON d.database_id = u.database_id
        WHERE u.user_type != 'staff' AND u.is_deleted = 0 AND u.database_id != ?`;
        const [rows] = await pool.query(query, [database_id]);
        return rows;
    }

    // get cash transaction history
    static async getCashTransactions(start, end, database_id) {
        const [_531] = await Account.getIdByAccountNumber("531");
        let query = `WITH partner_balance AS (
            SELECT
                SUM(CASE WHEN ji.debit IS NOT NULL THEN ji.debit ELSE 0 END) AS debit,
                SUM(CASE WHEN ji.credit IS NOT NULL THEN ji.credit ELSE 0 END) AS credit
            FROM
                journal_items ji
            INNER JOIN
                journal_vouchers jv ON ji.journal_id_fk = jv.journal_id
            WHERE
                ji.account_id_fk = ?
                AND Date(jv.journal_date) < ?
                AND ji.database_id = ?
                AND ji.is_deleted = 0
        )
        SELECT
            NULL AS journal_date,
            NULL AS journal_datetime,
            NULL AS journal_number,
            'Initial Balance' AS journal_description,
            COALESCE(pb.debit, 0) AS debit,
            COALESCE(pb.credit, 0) AS credit,
			NULL as notes,

            COALESCE(pb.debit, 0) - COALESCE(pb.credit, 0) AS balance
        FROM
            partner_balance pb

        UNION
        (
        SELECT
        DATE(jv.journal_date) AS journal_date,
        jv.journal_date AS journal_datetime,
        jv.journal_number,
        jv.journal_description,
        ji.debit,
        ji.credit,
		ji.notes,
        NULL AS balance
        FROM
        journal_items ji
        INNER JOIN
        journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
        WHERE
        ji.account_id_fk  = ?
        AND DATE(jv.journal_date) BETWEEN ? AND ?
        AND ji.is_deleted = 0
        AND ji.database_id = ?
        )
        ORDER BY
        journal_datetime ASC`;

        const [rows] = await pool.query(query, [
            _531.id,
            start,
            database_id,
            _531.id,
            start,
            end,
            database_id,
        ]);
        return rows;
    }
}

module.exports = BalanceModel;
