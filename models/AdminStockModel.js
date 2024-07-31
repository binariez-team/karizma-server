const pool = require("../config/database");

class Product {
	// get all products
	static async getAll(user) {
		let id = user.user_id;
		const query = `SELECT
            C.category_name,
			B.brand_name,
            P.*,
			I.grandwhole_price_usd,
            I.whole_price_usd,
            I.unit_price_usd,

            IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND user_id_fk = ? AND transaction_type = 'SUPPLY'), 0) 

			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND user_id_fk = ? AND transaction_type = 'RETURN'), 0)

			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND user_id_fk = ? AND transaction_type = 'SALE'), 0)

			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND user_id_fk = ? AND transaction_type = 'DISPOSE'), 0)

			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND user_id_fk = ? AND transaction_type = 'DELIVER'), 0)

			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'REVERSERETURN'), 0)

			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'REVERSEDISPOSE'), 0)



			AS quantity
            FROM products P
			INNER JOIN inventory I ON P.product_id = I.product_id_fk
            LEFT JOIN products_categories C ON P.category_id_fk = C.category_id
			LEFT JOIN products_brands B ON P.brand_id_fk = B.brand_id
            WHERE P.is_deleted = 0
			AND user_id_fk = ?
            ORDER BY P.product_id ASC`;

		const [result] = await pool.query(query, [id, id, id, id, id, id, id, id]);
		return result;
	}

	// get by product_id
	static async getById(product_id) {
		const [rows] = await pool.query(
			`SELECT
            C.category_name,
			B.brand_name,
            P.*,
			I.grandwhole_price_usd,
            I.whole_price_usd,
            I.unit_price_usd,
            IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'SUPPLY'), 0) 
			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'RETURN'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'SALE'), 0)
			AS quantity
            FROM products P
			INNER JOIN inventory I ON P.product_id = I.product_id_fk
            LEFT JOIN products_categories C ON P.category_id_fk = C.category_id
			LEFT JOIN products_brands B ON P.brand_id_fk = B.brand_id
            WHERE P.product_id = ?`,
			[product_id]
		);
		return rows;
	}

	// create new product
	static async create(data, user) {
		const connection = await pool.getConnection();
		try {
			// begin transaction
			await connection.beginTransaction();

			let product = {
				category_id_fk: data.category_id_fk,
				brand_id_fk: data.brand_id_fk,
				product_name: data.product_name,
				unit_cost_usd: data.unit_cost_usd,
				product_notes: data.product_notes,
			};
			// // insert into product table
			const [rows] = await connection.query(
				`INSERT INTO products SET ?`,
				product
			);

			let inventory = {
				product_id_fk: rows.insertId,
				user_id_fk: user.user_id,
				grandwhole_price_usd: data.grandwhole_price_usd,
				whole_price_usd: data.whole_price_usd,
				unit_price_usd: data.unit_price_usd,
			};
			await connection.query(`INSERT INTO inventory SET ?`, inventory);

			// // commit transaction
			await connection.commit();

			return rows;
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	// update existing product
	static async update(data, user) {
		const connection = await pool.getConnection();
		try {
			// begin transaction
			await connection.beginTransaction();

			let product = {
				category_id_fk: data.category_id_fk,
				brand_id_fk: data.brand_id_fk,
				product_name: data.product_name,
				unit_cost_usd: data.unit_cost_usd,
				product_notes: data.product_notes,
			};

			// update product table
			await connection.query(`UPDATE products SET ? WHERE product_id = ?`, [
				product,
				data.product_id,
			]);

			// update inventory
			let inventory = {
				grandwhole_price_usd: data.grandwhole_price_usd,
				whole_price_usd: data.whole_price_usd,
				unit_price_usd: data.unit_price_usd,
			};
			await connection.query(
				`UPDATE inventory SET ? WHERE product_id_fk = ? AND user_id_fk = ?`,
				[inventory, data.product_id, user.user_id]
			);

			// commit transaction
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	// delete product
	static async delete(id) {
		const connection = await pool.getConnection();
		try {
			// begin transaction
			await connection.beginTransaction();

			// delete from product table
			await connection.query(
				`UPDATE products SET is_deleted = 1 WHERE product_id = ?`,
				id
			);

			// delete from inventory
			await connection.query(
				`UPDATE inventory SET is_deleted = 1 WHERE product_id_fk = ?`,
				id
			);

			// commit transaction
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}
}

module.exports = Product;
