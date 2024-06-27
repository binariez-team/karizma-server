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
				AND O.is_approved = 1
				AND O.user_id_fk = ? `;
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

	// fetch pending
	static async fetchPendingInvoices(user_id) {
		let sql = `SELECT
                O.*,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('record_id', M.record_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_price', M.unit_price)) items
            	FROM deliver_orders O
            	INNER JOIN deliver_order_items M ON O.order_id = M.order_id_fk
				INNER JOIN products S ON S.product_id = M.product_id
				WHERE O.is_deleted = 0
				AND O.is_approved = 0
				AND O.user_id_fk = ? 
				GROUP BY O.order_id
				ORDER BY order_date DESC, O.invoice_number DESC`;

		const [rows] = await pool.query(sql, [user_id]);
		return rows;
	}

	// approve pending invoice
	static async approvePendingInvoice(id, user_id, admin_id) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			await connection.query(
				`UPDATE deliver_orders SET is_approved = 1 WHERE order_id = ?`,
				id
			);

			//	********************************
			//	loop of each invoice item record
			//	********************************

			let [items] = await connection.query(
				`SELECT * FROM deliver_order_items WHERE order_id_fk = ?`,
				id
			);
			for (const record of items) {
				// check if inventory records has previously inserted
				let [[inserted]] = await connection.query(
					`SELECT * FROM inventory WHERE product_id_fk = ? AND user_id_fk = ? AND is_deleted = 0;`,
					[record.product_id, user_id]
				);

				// if records have not been inserted before
				if (!inserted) {
					// prepare default inventory record prices (created by admin)
					let [[rows]] = await connection.query(
						`SELECT * FROM inventory WHERE user_id_fk = ? AND product_id_fk = ?;`,
						[admin_id, record.product_id]
					);
					let {
						grandwhole_price_usd,
						whole_price_usd,
						unit_price_usd,
					} = rows;
					const inventoryRecord = {
						product_id_fk: record.product_id,
						user_id_fk: user_id,
						grandwhole_price_usd: grandwhole_price_usd,
						whole_price_usd: whole_price_usd,
						unit_price_usd: unit_price_usd,
					};
					// insert a new inventory record with default prices
					await connection.query(
						`INSERT INTO inventory SET ?`,
						inventoryRecord
					);
				}

				// add user record to inventory transactions
				await connection.query(
					`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) VALUES (${record.product_id}, ${user_id}, ${record.quantity}, 'DELIVER');`
				);
			}

			// after successfull
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}
}

module.exports = UserHistory;
