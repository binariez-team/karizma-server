const pool = require("../config/database");
// const moment = require("moment");
const moment = require("moment-timezone");

class DeliverInvoice {
	static async create(order, items, user) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
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

			// generate invoice_number
			let [[{ number }]] = await connection.query(
				`SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number, 4) AS UNSIGNED)), 1000) + 1 AS number FROM deliver_orders`
			);
			let invoice_number = `DEL${number.toString().padStart(4, "0")}`;
			// let invoice_number = invoice.invoice_number;
			await connection.query(
				`UPDATE deliver_orders SET invoice_number = ? WHERE order_id = ?`,
				[invoice_number, order_id]
			);

			//	loop of each invoice item record
			for (const record of items) {
				delete record.product_name;

				// insert into order items
				await connection.query(
					`INSERT INTO deliver_order_items SET ?`,
					{ ...record, order_id_fk: order_id }
				);

				// check if inventory records has previously inserted
				let [[inserted]] = await connection.query(
					`SELECT * FROM inventory WHERE product_id_fk = ? AND user_id_fk = ? AND is_deleted = 0;`,
					[record.product_id, order.user_id_fk]
				);

				// if records have not been inserted before
				if (!inserted) {
					// prepare default inventory record prices (created by admin)
					let [[rows]] = await connection.query(
						`SELECT * FROM inventory WHERE user_id_fk = ? AND product_id_fk = ?;`,
						[order.admin_id_fk, record.product_id]
					);
					let {
						grandwhole_price_usd,
						whole_price_usd,
						unit_price_usd,
					} = rows;
					const inventoryRecord = {
						product_id_fk: record.product_id,
						user_id_fk: order.user_id_fk,
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

				// add admin record to inventory transactions
				await connection.query(
					`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) VALUES (${record.product_id}, ${order.admin_id_fk}, ${record.quantity}, 'DELIVER');`
				);

				// add user record to inventory transactions
				await connection.query(
					`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) VALUES (${record.product_id}, ${order.user_id_fk}, ${record.quantity}, 'DELIVER');`
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

module.exports = DeliverInvoice;
