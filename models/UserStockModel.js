const pool = require("../config/database");
const moment = require("moment-timezone");

class UserProduct {
	static async getAll(user_id) {
		const query = `SELECT
            C.category_name,
			B.brand_name,
            P.*,
			I.grandwhole_price_usd,
            I.whole_price_usd,
            I.unit_price_usd,

            IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'DELIVER' ), 0) 
			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'DELETE' ), 0)
			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'RETURN'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'REVERSERETURN'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'SALE'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'DISPOSE'), 0)
			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'REVERSEDISPOSE'), 0)

			AS quantity
            FROM products P
			INNER JOIN inventory I ON P.product_id = I.product_id_fk
            LEFT JOIN products_categories C ON P.category_id_fk = C.category_id
			LEFT JOIN products_brands B ON P.brand_id_fk = B.brand_id
            WHERE P.is_deleted = 0 AND user_id_fk = ?
            ORDER BY P.product_id ASC;`;

		const [result] = await pool.query(query, [
			user_id,
			user_id,
			user_id,
			user_id,
			user_id,
			user_id,
			user_id,
			user_id,
		]);
		return result;
	}

	static async getById(user_id, product_id) {
		const query = `SELECT
            C.category_name,
      		B.brand_name,
            P.*,
      		I.grandwhole_price_usd,
            I.whole_price_usd,
            I.unit_price_usd,
			
            IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'DELIVER' ), 0)
      		+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'DELETE' ), 0)
			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'RETURN'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'REVERSERETURN'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'SALE'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'DISPOSE'), 0)
			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'REVERSEDISPOSE'), 0)
			
			AS quantity
			FROM products P
			INNER JOIN inventory I ON P.product_id = I.product_id_fk
			LEFT JOIN products_categories C ON P.category_id_fk = C.category_id
			LEFT JOIN products_brands B ON P.brand_id_fk = B.brand_id
			WHERE P.is_deleted = 0 AND user_id_fk = ? AND P.product_id = ?;`;

		const [result] = await pool.query(query, [
			user_id,
			user_id,
			user_id,
			user_id,
			user_id,
			user_id,
			user_id,
			user_id,
			product_id,
		]);
		return result;
	}
	static async update(user_id, product_id, prices) {
		const query = `UPDATE inventory
            SET grandwhole_price_usd = ?,
            whole_price_usd = ?,
            unit_price_usd = ?
            WHERE product_id_fk = ? AND user_id_fk = ?;`;

		await pool.query(query, [
			prices.grandwhole_price_usd,
			prices.whole_price_usd,
			prices.unit_price_usd,
			product_id,
			user_id,
		]);
	}

	static async dispose(user_id, info, products) {
		const connection = await pool.getConnection();
		moment.tz.setDefault("Asia/Beirut");

		try {
			await connection.beginTransaction();

			info.dispose_datetime = moment(info.dispose_datetime).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);
			info.user_id = user_id;

			let [[{ number }]] = await connection.query(
				`SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM dispose_products`
			);

			info.invoice_number = `DIS${number.toString().padStart(4, "0")}`;

			let query = `INSERT INTO dispose_products SET ?`;

			const [result] = await connection.query(
				`INSERT INTO dispose_products SET ?`,
				info
			);
			let dispose_items = products.map((product) => [
				result.insertId,
				product.product_id,
				product.quantity,
				product.unit_cost,
			]);

			await connection.query(
				`INSERT INTO dispose_products_items ( dispose_id, product_id, quantity, unit_cost ) VALUES ?`,
				[dispose_items]
			);

			query = `INSERT INTO inventory_transactions (user_id_fk, product_id_fk, transaction_type, transaction_datetime, quantity)
			VALUES ?;`;

			const values = products.map((product) => [
				user_id,
				product.product_id,
				"DISPOSE",
				info.dispose_datetime,
				product.quantity,
			]);

			await connection.query(query, [values]);

			await connection.commit();
			return result.insertId;
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	static async updateDispose(user_id, info, products) {
		const connection = await pool.getConnection();
		moment.tz.setDefault("Asia/Beirut");
		try {
			await connection.beginTransaction();

			//delete old dispose
			//check existing order for user
			let [[disposeCheck]] = await connection.query(
				`
				SELECT * FROM dispose_products WHERE dispose_id = ? AND user_id = ?`,
				[info.dispose_id, user_id]
			);
			if (!disposeCheck) throw new Error("Order not found");

			//fix datetime
			info.dispose_datetime = moment(info.dispose_datetime).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);

			//inventory_transactions
			await connection.query(
				`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, transaction_type, quantity) SELECT product_id, ?, 'REVERSEDISPOSE', quantity FROM dispose_products_items WHERE dispose_id = ?`,
				[user_id, info.dispose_id]
			);

			let query = `DELETE FROM dispose_products_items WHERE dispose_id = ?;`;
			await connection.query(query, [info.dispose_id]);

			/////////////////add new dispose//////////////

			query = `UPDATE dispose_products SET ? WHERE dispose_id = ?;`;
			await connection.query(query, [info, info.dispose_id]);

			let dispose_items = products.map((product) => [
				info.dispose_id,
				product.product_id,
				product.quantity,
				product.unit_cost,
			]);

			await connection.query(
				`INSERT INTO dispose_products_items ( dispose_id, product_id, quantity, unit_cost ) VALUES ?`,
				[dispose_items]
			);

			query = `INSERT INTO inventory_transactions (user_id_fk, product_id_fk, transaction_type, transaction_datetime, quantity)
			VALUES ?;`;

			const values = products.map((product) => [
				user_id,
				product.product_id,
				"DISPOSE",
				info.dispose_datetime,
				product.quantity,
			]);

			await connection.query(query, [values]);

			await connection.commit();
			return info.dispose_id;
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	static async deleteDispose(user_id, dispose_id) {
		const connection = await pool.getConnection();

		try {
			await connection.beginTransaction();

			//check existing order for user
			let [[disposeCheck]] = await connection.query(
				`
				SELECT * FROM dispose_products WHERE dispose_id = ? AND user_id = ?`,
				[dispose_id, user_id]
			);
			if (!disposeCheck) throw new Error("Order not found");

			let query = `UPDATE dispose_products_items SET is_deleted = 1 WHERE dispose_id = ?;`;
			await connection.query(query, [dispose_id]);

			query = `UPDATE dispose_products SET is_deleted = 1 WHERE dispose_id = ?;`;
			await connection.query(query, [dispose_id]);

			//inventory_transactions
			await connection.query(
				`INSERT INTO inventory_transactions (product_id_fk, user_id_fk, transaction_type, quantity) SELECT product_id, ?, 'REVERSEDISPOSE', quantity FROM dispose_products_items WHERE dispose_id = ?`,
				[user_id, dispose_id]
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

module.exports = UserProduct;
