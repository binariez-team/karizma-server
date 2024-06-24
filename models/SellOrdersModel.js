const pool = require("../config/database");
// const moment = require("moment");
const moment = require("moment-timezone");

class SellOrders {
	static async addOrder(order, items, user_id) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			order.order_datetime = moment(order.order_datetime).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);

			const [result] = await connection.query(
				`INSERT INTO sales_orders SET ?`,
				order
			);

			let order_id = result.insertId;

			// generate invoice_number
			let [[{ number }]] = await connection.query(
				`SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number, 4) AS UNSIGNED)), 1000) + 1 AS number FROM sales_orders`
			);

			let invoice_number = `INV${number.toString().padStart(4, "0")}`;

			// let invoice_number = invoice.invoice_number;
			await connection.query(
				`UPDATE sales_orders SET invoice_number = ? WHERE order_id = ?`,
				[invoice_number, order_id]
			);

			let invoice_map = Array.from(items).map(function (item) {
				return [
					order_id,
					item.product_id,
					item.quantity,
					item.unit_price,
					item.price_type,
					item.unit_cost,
					item.quantity * item.unit_price,
				];
			});

			await connection.query(
				`INSERT INTO sales_order_items (order_id, product_id, quantity,  unit_price, price_type,unit_cost, total_price ) VALUES ?`,
				[invoice_map]
			);

			// modify qty for stock managed items

			if (items.length > 0) {
				let queries = "";
				let product_id = null;
				let quantity = null;
				let params = [];
				items.forEach((element) => {
					product_id = element["product_id"];
					quantity = element["quantity"];
					params = params.concat([product_id, user_id, quantity]);
					//add order_items to inventory transactions
					queries += `INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) VALUES (?,?,?, 'SALE');`;
				});
				await connection.query(queries, params);
			}

			await connection.commit();
			return { order_id };
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}
	static async editOrder(order, items, user_id) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			let order_id = order.order_id;

			//check existing order for user
			let [[orderCheck]] = await connection.query(
				`SELECT * FROM sales_orders WHERE order_id = ? AND user_id = ?`,
				[order_id, user_id]
			);
			console.log(orderCheck, order_id, order, user_id);
			if (!orderCheck) throw new Error("Order not found");

			// update inventory qty for deleted items
			let inventoryQueries = "";
			let product_id = null;
			let quantity = null;
			console.log(order_id);

			// add deleted items to inventory transactions
			await connection.query(
				`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, transaction_type, quantity) SELECT product_id, ?, 'DELETE', quantity FROM sales_order_items WHERE order_id = ?`,
				[user_id, order_id]
			);
			//add order_items to inventory transactions
			items.forEach((element) => {
				product_id = element.product_id;
				quantity = element.quantity;
				// update inventory
				inventoryQueries += `INSERT INTO inventory_transactions (product_id_fk, user_id_fk, transaction_type, quantity) VALUES (${product_id}, ${user_id}, 'SALE', ${quantity});`;
			});
			await connection.query(inventoryQueries);

			// delete old items
			let deleteItemsQuery = `DELETE FROM sales_order_items WHERE order_id = ?`;
			await connection.query(deleteItemsQuery, order_id);

			// delete old invoice
			let deleteOrderQuery = `DELETE FROM sales_orders WHERE order_id = ?`;
			await connection.query(deleteOrderQuery, order_id);

			// insert the new order

			// fix date
			order.order_datetime = moment(order.order_datetime).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);

			// fix invoice number
			order.invoice_number = `INV${order.invoice_number}`;

			//add user_id to order
			order.user_id = user_id;

			// insert query
			const [result] = await connection.query(
				`INSERT INTO sales_orders SET ?`,
				order
			);

			let invoice_map = Array.from(items).map(function (item) {
				return [
					order_id,
					item.product_id,
					item.quantity,
					item.unit_price,
					item.price_type,
					item.unit_cost,
					item.quantity * item.unit_price,
				];
			});

			const [new_order] = await connection.query(
				`INSERT INTO sales_order_items (order_id, product_id, quantity,  unit_price, price_type,unit_cost, total_price ) VALUES ?`,
				[invoice_map]
			);

			await connection.commit();
			return new_order.insertId;
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	// delete invoice
	static async deleteOrder(order_id, user_id) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			//check existing order for user
			let [[orderCheck]] = await connection.query(
				`
				SELECT * FROM sales_orders WHERE order_id = ? AND user_id = ?`,
				[order_id, user_id]
			);
			if (!orderCheck) throw new Error("Order not found");

			// add deleted items to inventory transactions
			await connection.query(
				`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, transaction_type, quantity) SELECT product_id, ?, 'DELETE', quantity FROM sales_order_items WHERE order_id = ?`,
				[user_id, order_id]
			);

			// delete old items
			let deleteItemsQuery = `DELETE FROM sales_order_items WHERE order_id = ?`;
			await connection.query(deleteItemsQuery, order_id);

			// delete old invoice
			let deleteOrderQuery = `DELETE FROM sales_orders WHERE order_id = ?`;
			await connection.query(deleteOrderQuery, order_id);

			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}
	static async getAddedOrderById(order_id, user_id) {
		const [order] = await pool.query(
			`SELECT * FROM sales_orders WHERE order_id = ? AND user_id = ?`,
			[order_id, user_id]
		);
		return order;
	}
}

module.exports = SellOrders;
