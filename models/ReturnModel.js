const pool = require("../config/database");
const moment = require("moment-timezone");
const Accounts = require("./AccountsModel");

class ReturnModel {
	static async addReturn(user_id, order, items, payment) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			order.order_datetime = moment(order.order_datetime).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);

			// generate invoice_number
			let [[{ number }]] = await connection.query(
				`SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number, 4) AS UNSIGNED)), 1000) + 1 AS number FROM return_orders`
			);
			order.invoice_number = `RET${number.toString().padStart(4, "0")}`;

			//insert transactions to new journal_items approch
			let query = `INSERT INTO journal_vouchers (user_id, journal_date, journal_number,journal_description, total_value, exchange_value) VALUES (?, ?, ?, ?, ?, ?)`;
			const [journal_voucher] = await connection.query(query, [
				user_id,
				order.order_datetime,
				order.invoice_number,
				"Return",
				order.total_amount,
				order.exchange_rate,
			]);
			order.journal_voucher_id = journal_voucher.insertId;

			let [_4111] = await Accounts.getIdByAccountNumber("4111");

			const firstItem = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: order.order_datetime,
				account_id_fk: _4111.id,
				reference_number: order.reference_number,
				partner_id_fk: order.customer_id,
				currency: "USD",
				debit: 0,
				credit: order.total_amount,
				exchange_value: order.exchange_rate,
			};

			await connection.query(`INSERT INTO journal_items SET ?`, firstItem);

			let [_7011] = await Accounts.getIdByAccountNumber("7011");
			const secondItem = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: order.order_datetime,
				account_id_fk: _7011.id,
				reference_number: order.reference_number,
				partner_id_fk: null,
				currency: "USD",
				debit: order.total_amount,
				credit: 0,
				exchange_value: order.exchange_rate,
			};

			await connection.query(`INSERT INTO journal_items SET ?`, secondItem);

			//add user_id to order
			order.user_id = user_id;

			//insert order
			const [result] = await connection.query(
				`INSERT INTO return_orders SET ?`,
				order
			);
			let order_id = result.insertId;

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
			//insert order_items
			await connection.query(
				`INSERT INTO return_order_items (order_id, product_id, quantity,  unit_price, price_type,unit_cost, total_price ) VALUES ?`,
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
					queries += `INSERT INTO inventory_transactions (product_id_fk, user_id_fk, quantity, transaction_type) VALUES (?,?,?, 'RETURN');`;
				});
				await connection.query(queries, params);
			}

			if (payment) {
				payment.payment_date = moment(payment.payment_date).format(
					`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
				);

				let [[{ number }]] = await connection.query(
					`SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'PAY%'`
				);

				let payment_number = `PAY${number.toString().padStart(4, "0")}`;

				//insert to vouchers and journal_items
				let query = `INSERT INTO journal_vouchers ( user_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
				const [journal_voucher] = await connection.query(query, [
					user_id,
					payment_number,
					payment.payment_date,
					"Payment",
					payment.amount,
				]);

				let [_531] = await Accounts.getIdByAccountNumber("531");

				const firstItem = {
					journal_id_fk: journal_voucher.insertId,
					journal_date: payment.payment_date,
					account_id_fk: _531.id,
					user_id: user_id,
					reference_number: payment.reference_number,
					partner_id_fk: payment.customer_id,
					currency: "USD",
					debit: 0,
					credit: payment.amount,
					exchange_value: payment.exchange_rate,
				};

				await connection.query(`INSERT INTO journal_items SET ?`, firstItem);

				let [_413] = await Accounts.getIdByAccountNumber("413");
				const secondItem = {
					journal_id_fk: journal_voucher.insertId,
					journal_date: payment.payment_date,
					account_id_fk: _413.id,
					reference_number: payment.reference_number,
					partner_id_fk: null,
					currency: "USD",
					debit: payment.amount,
					credit: 0,
					exchange_value: payment.exchange_rate,
				};
				await connection.query(`INSERT INTO journal_items SET ?`, secondItem);
			}

			await connection.commit();
			return { order: order_id };
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}
	static async editReturn(user_id, order, items) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			let order_id = order.order_id;

			//check existing order for user
			let [[orderCheck]] = await connection.query(
				`SELECT * FROM return_orders WHERE order_id = ? AND user_id = ?`,
				[order_id, user_id]
			);
			if (!orderCheck) throw new Error("Order not found");

			// update inventory qty for deleted items
			let inventoryQueries = "";
			let product_id = null;
			let quantity = null;

			// add deleted items to inventory transactions
			await connection.query(
				`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, transaction_type, quantity) SELECT product_id, ?, 'REVERSERETURN', quantity FROM return_order_items WHERE order_id = ?`,
				[user_id, order_id]
			);
			//add order_items to inventory transactions
			items.forEach((element) => {
				product_id = element.product_id;
				quantity = element.quantity;
				// update inventory
				inventoryQueries += `INSERT INTO inventory_transactions (product_id_fk, user_id_fk, transaction_type, quantity) VALUES (${product_id}, ${user_id}, 'RETURN', ${quantity});`;
			});
			await connection.query(inventoryQueries);

			//delete voucher and items
			let deleteVoucherQuery = `DELETE FROM journal_vouchers WHERE journal_id = ?`;
			await connection.query(deleteVoucherQuery, orderCheck.journal_voucher_id);

			let deleteJournalItemsQuery = `DELETE FROM journal_items WHERE journal_id_fk = ?`;
			await connection.query(
				deleteJournalItemsQuery,
				orderCheck.journal_voucher_id
			);

			// delete old items
			let deleteItemsQuery = `DELETE FROM return_order_items WHERE order_id = ?`;
			await connection.query(deleteItemsQuery, order_id);

			// delete old invoice
			let deleteOrderQuery = `DELETE FROM return_orders WHERE order_id = ?`;
			await connection.query(deleteOrderQuery, order_id);

			// insert the new order

			// fix date
			order.order_datetime = moment(order.order_datetime).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);

			// fix invoice number
			order.invoice_number = `RET${order.invoice_number.padStart(4, "0")}`;

			//insert transactions to new journal_items approch
			let query = `INSERT INTO journal_vouchers (user_id, journal_date, journal_number,journal_description, total_value, exchange_value) VALUES (?, ?, ?, ?, ?, ?)`;
			const [journal_voucher] = await connection.query(query, [
				user_id,
				order.order_datetime,
				order.invoice_number,
				"Return",
				order.total_amount,
				order.exchange_rate,
			]);
			order.journal_voucher_id = journal_voucher.insertId;

			let [_4111] = await Accounts.getIdByAccountNumber("4111");

			const firstItem = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: order.order_datetime,
				account_id_fk: _4111.id,
				reference_number: order.reference_number,
				partner_id_fk: order.customer_id,
				currency: "USD",
				debit: 0,
				credit: order.total_amount,
				exchange_value: order.exchange_rate,
			};

			await connection.query(`INSERT INTO journal_items SET ?`, firstItem);

			let [_7011] = await Accounts.getIdByAccountNumber("7011");
			const secondItem = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: order.order_datetime,
				account_id_fk: _7011.id,
				reference_number: order.reference_number,
				partner_id_fk: null,
				currency: "USD",
				debit: order.total_amount,
				credit: 0,
				exchange_value: order.exchange_rate,
			};

			await connection.query(`INSERT INTO journal_items SET ?`, secondItem);

			//add user_id to order
			order.user_id = user_id;

			// insert query
			const [result] = await connection.query(
				`INSERT INTO return_orders SET ?`,
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
				`INSERT INTO return_order_items (order_id, product_id, quantity,  unit_price, price_type,unit_cost, total_price ) VALUES ?`,
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
	static async deleteReturn(user_id, order_id) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			//check existing order for user
			let [[orderCheck]] = await connection.query(
				`
				SELECT * FROM return_orders WHERE order_id = ? AND user_id = ?`,
				[order_id, user_id]
			);
			if (!orderCheck) throw new Error("Order not found");

			// add deleted items to inventory transactions
			await connection.query(
				`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, transaction_type, quantity) SELECT product_id, ?, 'REVERSERETURN', quantity FROM return_order_items WHERE order_id = ?`,
				[user_id, order_id]
			);

			//delete voucher and items
			let deleteVoucherQuery = `DELETE FROM journal_vouchers WHERE journal_id = ?`;
			await connection.query(deleteVoucherQuery, orderCheck.journal_voucher_id);

			let deleteJournalItemsQuery = `DELETE FROM journal_items WHERE journal_id_fk = ?`;
			await connection.query(
				deleteJournalItemsQuery,
				orderCheck.journal_voucher_id
			);

			// delete old items
			let deleteItemsQuery = `DELETE FROM return_order_items WHERE order_id = ?`;
			await connection.query(deleteItemsQuery, order_id);

			// delete old invoice
			let deleteOrderQuery = `DELETE FROM return_orders WHERE order_id = ?`;
			await connection.query(deleteOrderQuery, order_id);

			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}
}

module.exports = ReturnModel;
