const pool = require("../config/database");
const moment = require("moment");

class UserHistory {
	// fetch deliver invoices for admin
	static async fetchDeliverHistory(user_id, criteria) {
		let sql = `SELECT
                O.*,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('record_id', M.record_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_price', M.unit_price)) items
            	FROM deliver_orders O
            	INNER JOIN deliver_order_items M ON O.order_id = M.order_id_fk
				INNER JOIN products S ON S.product_id = M.product_id
				WHERE O.is_deleted = 0
				AND o.user_id_fk = ? `;
		const params = [user_id];
		if (criteria.invoice_number) {
			sql += ` AND O.invoice_number = ?`;
			params.push(criteria.invoice_number);
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
}

module.exports = UserHistory;
