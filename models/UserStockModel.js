const pool = require("../config/database");

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
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'RETURN'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'SALE'), 0)
			- IFNULL((SELECT SUM(quantity) FROM inventory_transactions WHERE product_id_fk = P.product_id  AND user_id_fk = ? AND transaction_type = 'DISPOSE'), 0)

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
    ]);
    return result;
  }
}

module.exports = UserProduct;
