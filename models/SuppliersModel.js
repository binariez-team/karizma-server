const pool = require("../config/database");

class Supplier {
    // get suppliers
    static async getAllSuppliers() {
        const [result] = await pool.query(
            "SELECT * FROM accounts WHERE is_supplier = 1 AND is_deleted = 0"
        );
        return result;
    }

    // get supplier by id
    static async getSupplierById(id) {
        const [[result]] = await pool.query(
            "SELECT * FROM accounts WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0",
            [id]
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
            [data, id]
        );
        return result;
    }

    // delete supplier
    static async deleteSupplier(id) {
        const [result] = await pool.query(
            "UPDATE accounts SET is_deleted = 1 WHERE account_id = ? AND is_supplier = 1",
            [id]
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
            [id, database_id]
        );
        return result;
    }
}

module.exports = Supplier;
