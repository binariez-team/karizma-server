const pool = require("../config/database");
const Account = require("./AccountsModel");

class BalanceModel {
	static async getBalanceByUserId(userId) {
		const [_531] = await Account.getIdByAccountNumber("531");
		const query = `SELECT COALESCE(sum(credit) - sum(debit),0) AS balance 
        FROM journal_items ji
        JOIN journal_vouchers jv
        ON ji.journal_id_fk = jv.journal_id
        where ji.is_deleted =0
        AND ji.account_id_fk=?
        AND jv.user_id =?;`;
		const [[rows]] = await pool.query(query, [_531.id, userId]);
		return rows;
	}

	static async getAllUsersBalance() {
		const [_531] = await Account.getIdByAccountNumber("531");
		const query = `SELECT u.user_id, COALESCE(SUM(ji.credit) - SUM(ji.debit), 0) AS balance
            FROM users u
            LEFT JOIN journal_vouchers jv ON u.user_id = jv.user_id
            LEFT JOIN journal_items ji ON jv.journal_id = ji.journal_id_fk 
            AND ji.is_deleted = 0
            AND ji.account_id_fk= ?
            GROUP BY u.user_id;`;
		const [rows] = await pool.query(query, [_531.id]);
		return rows;
	}
}

module.exports = BalanceModel;
