const pool = require("../config/database");

class Supplier {
  // get suppliers
  static async getAllSuppliers() {
    const [result] = await pool.query(
      "SELECT * FROM accounts WHERE is_supplier = 1 AND is_deleted = 0"
    );
    return result;
  }

  // get supplier by id
  static async getSupplierById(id) {
    const [[result]] = await pool.query(
      "SELECT * FROM accounts WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0",
      [id]
    );
    return result;
  }

  // create supplier
  static async createSupplier(data) {
    data.is_supplier = 1;
    const [result] = await pool.query("INSERT INTO accounts SET ?", data);
    return result;
  }

  // update supplier
  static async updateSupplier(id, data) {
    const [result] = await pool.query(
      "UPDATE accounts SET ? WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0",
      [data, id]
    );
    return result;
  }

  // delete supplier
  static async deleteSupplier(id) {
    const [result] = await pool.query(
      "UPDATE accounts SET is_deleted = 1 WHERE account_id = ? AND is_supplier = 1",
      [id]
    );
    return result;
  }
}

module.exports = Supplier;
