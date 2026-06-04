const pool = require("../config/database");
const moment = require("moment-timezone");
const Accounts = require("./AccountsModel");

class Supplier {
    // get suppliers
    static async getAllSuppliers() {
        const [result] = await pool.query(
            "SELECT * FROM accounts WHERE is_supplier = 1 AND is_deleted = 0",
        );
        return result;
    }

    // get supplier by id
    static async getSupplierById(id) {
        const [[result]] = await pool.query(
            "SELECT * FROM accounts WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0",
            [id],
        );
        return result;
    }

    // create supplier
    static async createSupplier(data) {
        data.is_supplier = 1;
        const [result] = await pool.query("INSERT INTO accounts SET ?", data);
        return result;
    }

    // update supplier
    static async updateSupplier(id, data) {
        const [result] = await pool.query(
            "UPDATE accounts SET ? WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0",
            [data, id],
        );
        return result;
    }

    // delete supplier
    static async deleteSupplier(id) {
        const [result] = await pool.query(
            "UPDATE accounts SET is_deleted = 1 WHERE account_id = ? AND is_supplier = 1",
            [id],
        );
        return result;
    }

    //get supplier total balance
    static async getSupplierTotalBalance(id, database_id) {
        const [[result]] = await pool.query(
            `SELECT
		COALESCE(SUM(ji.credit) - SUM(ji.debit), 0) AS balance
		FROM journal_vouchers jv
		LEFT JOIN
		journal_items ji ON jv.journal_id = ji.journal_id_fk
		WHERE
		ji.partner_id_fk = ?
		AND ji.database_id = ?
		AND ji.is_deleted = 0`,
            [id, database_id],
        );
        return result;
    }

    // add manual supplier debts
    static async addManualDebt(database_id, data) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            data.transaction_datetime = moment(
                data.transaction_datetime,
            ).format(`YYYY-MM-DD HH:mm:ss`);

            // create journal voucher
            let query = `INSERT INTO journal_vouchers (journal_date, journal_description, journal_notes, total_value, database_id) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                data.transaction_datetime,
                "Manual Transaction",
                data.transaction_notes,
                data.amount,
                database_id,
            ]);

            let [_4011] = await Accounts.getIdByAccountNumber("4011");
            const invoicesAccount = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: data.transaction_datetime,
                account_id_fk: _4011.id,
                partner_id_fk: data.selected_account,
                debit: 0,
                credit: 0,
                database_id: database_id,
            };

            let [_101] = await Accounts.getIdByAccountNumber("101");
            const capitalAccount = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: data.transaction_datetime,
                account_id_fk: _101.id,
                debit: 0,
                credit: 0,
                database_id: database_id,
            };

            // debit or credit based on transaction type
            if (data.transaction_type == "ADD") {
                invoicesAccount.credit = data.amount;
                capitalAccount.debit = data.amount;
            } else {
                invoicesAccount.debit = data.amount;
                capitalAccount.credit = data.amount;
            }

            // add journal items
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                invoicesAccount,
            );
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                capitalAccount,
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

module.exports = Supplier;
