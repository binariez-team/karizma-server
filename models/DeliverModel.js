const pool = require("../config/database");
const moment = require("moment");

class DeliverInvoice {
	static async create(order, invoice, user) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			order.order_datetime = moment(order.order_datetime).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);
			order.admin_id_fk = user.user_id;

			// insert into deliver_orders
			const [result] = await connection.query(
				`INSERT INTO deliver_orders SET ?`,
				order
			);

			// inserted order ID
			let order_id = result.insertId;

			let order_items = Array.from(invoice).map(function (item) {
				return [
					order_id,
					item.product_id,
					item.quantity,
					item.unit_cost_usd,
				];
			});

			await connection.query(
				`INSERT INTO deliver_order_items (order_id_fk, product_id_fk, quantity, unit_price) VALUES ?`,
				[order_items]
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

module.exports = DeliverInvoice;
