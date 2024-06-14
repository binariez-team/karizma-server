const pool = require("../config/database");

class UserProduct {
  static async getAll(user_id) {
    const [rows] = await pool.query(
      `SELECT * FROM inventory_transactions as IT
        LEFT JOIN products as P
        ON IT.product_id_fk = P.product_id
        WHERE user_id_fk = ? AND P.is_deleted = 0;`,
      [user_id]
    );
    return rows;
  }
}

module.exports = UserProduct;
