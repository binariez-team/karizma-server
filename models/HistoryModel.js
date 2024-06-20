const pool = require("../config/database");
const moment = require("moment");

class History {
	// get all invoices
	static async fetchSalesHistory(user_id, criteria) {
		let sql = `SELECT
                A.name AS customer_name,
                A.phone AS customer_phone,
                A.address AS customer_address,
                A.financial_number,
                O.*,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('order_item_id', M.order_item_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_cost', M.unit_cost, 'unit_price', M.unit_price, 'total_price', M.total_price)) items
            FROM sales_orders O
            INNER JOIN sales_order_items M ON O.order_id = M.order_id
            INNER JOIN products S ON S.product_id = M.product_id
            INNER JOIN accounts  A ON O.customer_id = A.account_id
            WHERE O.is_deleted = 0 AND A.user_id = ? `;
		const params = [user_id];
		if (criteria.invoice_number) {
			sql += ` AND O.invoice_number = ?`;
			params.push(criteria.invoice_number);
		}
		if (criteria.customer_id) {
			sql += ` AND O.customer_id = ?`;
			params.push(criteria.customer_id);
		}
		if (criteria.invoice_date) {
			sql += ` AND DATE(order_datetime) = ?`;
			params.push(moment(criteria.invoice_date).format("yyyy-MM-DD"));
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

module.exports = History;
