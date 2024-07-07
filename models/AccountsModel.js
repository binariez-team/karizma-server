const pool = require("../config/database");

class Accounts {
	static async getAccountDetailsById(user_id, account_id, startDate, endDate) {
		let query = `
    WITH partner_balance AS (
        SELECT
            SUM(CASE WHEN ji.debit IS NOT NULL THEN ji.debit ELSE 0 END) AS debit,
            SUM(CASE WHEN ji.credit IS NOT NULL THEN ji.credit ELSE 0 END) AS credit,
            SUM(CASE WHEN ji.debit_lbp IS NOT NULL THEN ji.debit_lbp ELSE 0 END) AS debit_lbp,
            SUM(CASE WHEN ji.credit_lbp IS NOT NULL THEN ji.credit_lbp ELSE 0 END) AS credit_lbp
        FROM
            journal_items ji
        INNER JOIN
            journal_vouchers jv ON ji.journal_id_fk = jv.journal_id
        WHERE
            ji.partner_id_fk = ?
            AND Date(jv.journal_date) < ?
            AND ji.is_deleted = 0
            AND jv.user_id = ?
    )
    SELECT
        NULL AS journal_date,
        NULL AS journal_number,
        'Initial Balance' AS journal_description,
        COALESCE(pb.debit, 0) AS debit,
        COALESCE(pb.credit, 0) AS credit,
        NULL AS currency,
        COALESCE(pb.debit_lbp, 0) AS debit_lbp,
        COALESCE(pb.credit_lbp, 0) AS credit_lbp,
        NULL AS exchange_value,
        NULL AS account_code,
        NULL AS account_name,
        COALESCE(pb.debit, 0) - COALESCE(pb.credit, 0) AS balance
    FROM
        partner_balance pb

    UNION
    (
    SELECT
    DATE(jv.journal_date) AS journal_date,
    jv.journal_number,
    jv.journal_description,
    ji.debit,
    ji.credit,
    ji.currency,
    ji.debit_lbp,
    ji.credit_lbp,
    ji.exchange_value,
    aa.code AS account_code,
    aa.name AS account_name,
    NULL AS balance
    FROM
    journal_items ji
    INNER JOIN
    accounts aa ON ji.partner_id_fk  = aa.account_id
    INNER JOIN
    journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
    WHERE
    ji.partner_id_fk  = ? -- Replace with the specific partner ID
    AND DATE(jv.journal_date) BETWEEN ? AND ?
    AND ji.is_deleted = 0
    AND jv.user_id = ?
    )
    ORDER BY
    journal_date ASC`;
		const [rows] = await pool.query(query, [
			account_id,
			startDate,
			user_id,
			account_id,
			startDate,
			endDate,
			user_id,
		]);
		return rows;
	}

	// get id by account number
	static async getIdByAccountNumber(number) {
		const query = `SELECT id FROM chart_of_accounts WHERE account_number = ?`;
		const [id] = await pool.query(query, number);
		return id;
	}

	//get multi accounts starting with account number
	static async getAccountsByAccountNumber(account_number) {
		const query = `SELECT * FROM chart_of_accounts WHERE account_number LIKE ?`;
		const [rows] = await pool.query(query, account_number);
		return rows;
	}
}
module.exports = Accounts;
