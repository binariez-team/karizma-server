const pool = require("../config/database");
const Account = require("./AccountsModel");
const moment = require("moment-timezone");

class BalanceModel {
    // get balance
    static async getBalance(database_id) {
        const [_531] = await Account.getIdByAccountNumber("531");
        const [_532] = await Account.getIdByAccountNumber("532");

        const query = `SELECT
                COALESCE(SUM(CASE 
                WHEN ji.account_id_fk = ? AND ji.database_id = ? 
                THEN ji.debit - ji.credit 
                ELSE 0 
                END), 0) AS cash_balance,
            
                COALESCE(SUM(CASE 
                WHEN ji.account_id_fk = ? AND ji.database_id = ? 
                THEN ji.debit - ji.credit 
                ELSE 0 
                END), 0) AS whish_balance
            
            FROM journal_items ji
            WHERE ji.is_deleted = 0;`;

        const [[rows]] = await pool.query(query, [
            _531.id,
            database_id,
            _532.id,
            database_id,
        ]);

        return rows;
    }

    // correct balance manually
    static async correctBalance(data, database_id) {
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            const date = moment().format(`YYYY-MM-DD HH:mm:ss`);

            // create journal voucher
            const query = `INSERT INTO journal_vouchers (journal_date, journal_number, journal_notes, journal_description, total_value, reference_number, database_id) VALUES (?, 'Manual Transaction', 'manual', ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                date,
                data.transaction_notes,
                data.amount,
                "manual",
                database_id,
            ]);

            // money account
            const [moneyAccount] = await Account.getIdByAccountNumber(
                data.money_account,
            );

            let cashDollar = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: date,
                account_id_fk: moneyAccount.id,
                reference_number: "manual",
                database_id: database_id,
            };

            // capital account
            let [_101] = await Account.getIdByAccountNumber("101");
            let capital = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: date,
                account_id_fk: _101.id,
                reference_number: "manual",
                database_id: database_id,
            };

            // check transaction type
            if (data.transaction_type == "ADD") {
                cashDollar.debit = data.amount;
                capital.credit = data.amount;
            } else {
                cashDollar.credit = data.amount;
                capital.debit = data.amount;
            }

            // create journal entries
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                cashDollar,
            );
            await connection.query(`INSERT INTO journal_items SET ?`, capital);

            // commit changes
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
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

    static async getTransferAccounts(database_id) {
        const query = `SELECT d.*, CONCAT(u.first_name, ' ', u.last_name) AS full_name FROM user_database d
        INNER JOIN users u ON d.database_id = u.database_id
        WHERE u.user_type != 'staff' AND u.is_deleted = 0 AND u.database_id != ?`;
        const [rows] = await pool.query(query, [database_id]);
        return rows;
    }

    // get cash transaction history
    static async getCashTransactions(start, end, database_id, accountNumber) {
        const [account] = await Account.getIdByAccountNumber(accountNumber);

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
            account.id,
            start,
            database_id,
            account.id,
            start,
            end,
            database_id,
        ]);
        return rows;
    }

    // self transfer
    static async selfTransfer(database_id, data) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            const transfer_date = moment().format(`YYYY-MM-DD HH:mm:ss`);

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers ( database_id, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                transfer_date,
                `Self Transfer`,
                data.amount,
            ]);

            // cash account
            const [cashAccount] = await Account.getIdByAccountNumber("531");

            // whish account
            const [whishAccount] = await Account.getIdByAccountNumber("532");

            let cashAccountEntry = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: transfer_date,
                account_id_fk: cashAccount.id,
            };

            let whishAccountEntry = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: transfer_date,
                account_id_fk: whishAccount.id,
            };

            // if transaction is from cash to whish
            if (data.from_account == 531) {
                cashAccountEntry.credit = data.amount;
                cashAccountEntry.notes = `Cash To Whish`;

                whishAccountEntry.debit = data.amount;
                whishAccountEntry.notes = `Cash To Whish`;
            } else {
                // else transaction is from whish to cash
                cashAccountEntry.debit = data.amount;
                cashAccountEntry.notes = `Whish To Cash`;

                whishAccountEntry.credit = data.amount;
                whishAccountEntry.notes = `Whish To Cash`;
            }

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                cashAccountEntry,
            );

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                whishAccountEntry,
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = BalanceModel;
