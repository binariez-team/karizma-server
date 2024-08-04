const pool = require("../config/database");
const moment = require("moment");

class AdminHistory {
	// fetch deliver invoices for admin
	static async fetchDeliverHistory(criteria) {
		let sql = `SELECT
                U.first_name AS first_name,
                O.*,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('record_id', M.record_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_price', M.unit_price)) items
            	FROM deliver_orders O
            	INNER JOIN deliver_order_items M ON O.order_id = M.order_id_fk
				INNER JOIN products S ON S.product_id = M.product_id
				INNER JOIN users U ON O.user_id_fk = U.user_id
				WHERE O.is_deleted = 0 `;
		const params = [];
		if (criteria.invoice_number) {
			sql += ` AND O.invoice_number = ?`;
			params.push(criteria.invoice_number);
		}
		if (criteria.user_id) {
			sql += ` AND O.user_id_fk = ?`;
			params.push(criteria.user_id);
		}
		if (criteria.order_date) {
			sql += ` AND DATE(order_datetime) = ?`;
			params.push(moment(criteria.order_date).format("yyyy-MM-DD"));
		}

		sql += ` GROUP BY O.order_id
        ORDER BY order_date DESC, O.invoice_number DESC
        LIMIT ? OFFSET ?`;
		params.push(criteria.limit || 100);
		params.push(criteria.offset || 0);

		const [rows] = await pool.query(sql, params);
		return rows;
	}

	// fetch moneyTransfer for admin
	static async fetchMoneyTransferHistory(criteria) {
		let sql = `SELECT 
        	U.first_name AS first_name,
        	jv.*,
        	DATE(jv.journal_date) AS order_date
			FROM journal_vouchers jv 
			INNER JOIN users U ON U.user_id = jv.user_id
			WHERE jv.journal_description ="Transfer"
			AND jv.is_deleted = 0 `;
		const params = [];
		if (criteria.invoice_number) {
			sql += ` AND jv.journal_number = ?`;
			params.push(criteria.invoice_number);
		}
		if (criteria.user_id) {
			sql += ` AND jv.user_id = ?`;
			params.push(criteria.user_id);
		}
		if (criteria.order_date) {
			sql += ` AND DATE(jv.journal_date) = ?`;
			params.push(moment(criteria.order_date).format("yyyy-MM-DD"));
		}

		sql += ` ORDER BY order_date DESC, jv.journal_number DESC
        LIMIT ? OFFSET ?`;
		params.push(criteria.limit || 100);
		params.push(criteria.offset || 0);

		const [rows] = await pool.query(sql, params);
		return rows;
	}

	//fetch suppliers payment history
	static async fetchSuppliersPaymentHistory(user_id, criteria) {
		let sql = `SELECT
						A.name AS partner_name,
						A.phone AS partner_phone,
						A.address AS partner_address,
						A.account_id AS partner_id,
						P.*,
						DATE(P.journal_date) AS payment_date
					FROM journal_vouchers P
					INNER JOIN journal_items I ON P.journal_id = I.journal_id_fk
					INNER JOIN accounts A ON I.partner_id_fk = A.account_id
					WHERE P.is_deleted = 0 AND P.user_id = ? AND journal_description = 'Receipt'`;
		const params = [user_id];
		if (criteria.payment_number) {
			sql += ` AND P.journal_number = ?`;
			params.push(criteria.payment_number);
		}
		if (criteria.partner_id) {
			sql += ` AND I.partner_id_fk = ?`;
			params.push(criteria.partner_id);
		}
		if (criteria.payment_date) {
			sql += ` AND DATE(P.journal_date) = ?`;
			params.push(moment(criteria.payment_date).format("yyyy-MM-DD"));
		}

		sql += ` ORDER BY payment_date DESC, P.journal_number DESC
				LIMIT ? OFFSET ?`;
		params.push(criteria.limit || 100);
		params.push(criteria.offset || 0);

		const [rows] = await pool.query(sql, params);
		return rows;
	}
}

module.exports = AdminHistory;
