const pool = require("../config/database");

class Product {
	// get all products
	static async getAll() {
		const query = `SELECT
            C.category_name,
			B.brand_name,
            P.*,
            IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'SUPPLY'), 0) 
			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'RETURN'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'SALE'), 0)
			AS quantity
            FROM products P
            LEFT JOIN products_categories C ON P.category_id_fk = C.category_id
			LEFT JOIN products_brands B ON P.brand_id_fk = B.brand_id
            WHERE P.is_deleted = 0
            ORDER BY P.product_id ASC`;

		const [result] = await pool.query(query);
		return result;
	}

	// get by product_id
	static async getById(product_id) {
		const [rows] = await pool.query(
			`SELECT
            C.category_name,
			B.brand_name,
            P.*,
            IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'SUPPLY'), 0) 
			+ IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'RETURN'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id AND transaction_type = 'SALE'), 0)
			AS quantity
            FROM products P
            LEFT JOIN products_categories C ON P.category_id_fk = C.category_id
			LEFT JOIN products_brands B ON P.brand_id_fk = B.brand_id
            WHERE P.product_id = ?`,
			[product_id]
		);
		return rows;
	}

	// create new product
	static async create(product) {
		const connection = await pool.getConnection();
		try {
			// begin transaction
			await connection.beginTransaction();

			// insert into product table
			const [rows, fields] = await connection.query(
				`INSERT INTO products SET ?`,
				product
			);

			// await connection.query(`INSERT INTO inventory SET ?`, inventory);

			// commit transaction
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
	static async update(product) {
		const connection = await pool.getConnection();
		try {
			// begin transaction
			await connection.beginTransaction();

			// update product table
			await connection.query(
				`UPDATE products SET ? WHERE product_id = ?`,
				[product, product.product_id]
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
