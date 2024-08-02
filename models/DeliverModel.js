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
			await connection.query(
				`UPDATE deliver_orders SET invoice_number = ? WHERE order_id = ?`,
				[invoice_number, order_id]
			);

			//	********************************
			//	loop of each invoice item record
			//	********************************

			for (const record of items) {
				delete record.product_name;

				// insert into order items
				await connection.query(`INSERT INTO deliver_order_items SET ?`, {
					...record,
					order_id_fk: order_id,
				});

				// add admin record to inventory transactions
				await connection.query(
					`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) VALUES (${record.product_id}, ${order.admin_id_fk}, ${record.quantity}, 'DELIVER');`
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
	static async update(order, items, user) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			order.order_datetime = moment(order.order_datetime).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);
			order.admin_id_fk = user.user_id;

			let [[checkPending]] = await connection.query(
				`SELECT * FROM deliver_orders WHERE order_id = ? AND is_approved = 0`,
				[order.order_id]
			);
			if (!checkPending) throw new Error("approved");

			// insert into deliver_orders
			const [result] = await connection.query(
				`UPDATE deliver_orders SET order_datetime = ?, total_price = ?, user_id_fk = ?, notes = ? WHERE order_id = ?`,
				[
					order.order_datetime,
					order.total_price,
					order.user_id_fk,
					order.notes,
					order.order_id,
				]
			);

			//return items to inventory
			await connection.query(
				`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) SELECT product_id, ${user.user_id}, quantity, 'REVERSEDELIVER' FROM deliver_order_items WHERE order_id_fk = ?`,
				[order.order_id]
			);

			//delete invoice items
			await connection.query(
				`DELETE FROM deliver_order_items WHERE order_id_fk = ?`,
				[order.order_id]
			);

			//	********************************
			//	loop of each invoice item record
			//	********************************

			for (const record of items) {
				delete record.product_name;

				// insert into order items
				await connection.query(`INSERT INTO deliver_order_items SET ?`, {
					...record,
					order_id_fk: order.order_id,
				});

				// add admin record to inventory transactions
				await connection.query(
					`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) VALUES (${record.product_id}, ${order.admin_id_fk}, ${record.quantity}, 'DELIVER');`
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

	static async delete(order_id, admin_id) {
		console.log(order_id, admin_id);
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			let [[checkPending]] = await connection.query(
				`SELECT * FROM deliver_orders WHERE order_id = ? AND is_approved = 0 AND admin_id_fk = ?`,
				[order_id, admin_id]
			);
			if (!checkPending) throw new Error("approved");

			//return items to inventory
			await connection.query(
				`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) SELECT product_id, ${admin_id}, quantity, 'REVERSEDELIVER' FROM deliver_order_items WHERE order_id_fk = ?`,
				[order_id]
			);

			//delete invoice items
			await connection.query(
				`UPDATE deliver_order_items SET is_deleted=1 WHERE order_id_fk = ?`,
				[order_id]
			);

			//delete invoice
			await connection.query(
				`UPDATE deliver_orders SET is_deleted=1 WHERE order_id = ?`,
				[order_id]
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
