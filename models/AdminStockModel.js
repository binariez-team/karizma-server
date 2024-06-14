const pool = require("../config/database");

class Product {
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
            INNER JOIN products_categories C ON P.category_id_fk = C.category_id
			INNER JOIN products_brands B ON P.brand_id_fk = B.brand_id
            WHERE P.is_deleted = 0
            ORDER BY P.product_id ASC`;

		const [result] = await pool.query(query);
		return result;
	}
}

module.exports = Product;
