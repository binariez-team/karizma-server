const pool = require("../config/database");

class Customer {
  // get customers
  static async getAllCustomers() {
    const [result] = await pool.query(
      "SELECT * FROM accounts WHERE is_customer = 1 AND is_deleted = 0"
    );
    return result;
  }

  // get customer by id
  static async getCustomerById(id) {
    const [[result]] = await pool.query(
      "SELECT * FROM accounts WHERE account_id = ? AND is_customer = 1 AND is_deleted = 0",
      [id]
    );
    return result;
  }

  // create customer
  static async createCustomer(data) {
    data.is_customer = 1;
    const [result] = await pool.query("INSERT INTO accounts SET ?", data);
    return result;
  }

  // update customer
  static async updateCustomer(id, data) {
    const [result] = await pool.query(
      "UPDATE accounts SET ? WHERE account_id = ? AND is_customer = 1 AND is_deleted = 0",
      [data, id]
    );
    return result;
  }

  // delete customer
  static async deleteCustomer(id) {
    const [result] = await pool.query(
      "UPDATE accounts SET is_deleted = 1 WHERE account_id = ? AND is_customer = 1",
      [id]
    );
    return result;
  }

  //////////////////////////////////
  //customer model related to user//
  //////////////////////////////////

  // get customers by user id
  static async getCustomersByUserId(id) {
    const [result] = await pool.query(
      "SELECT * FROM accounts WHERE user_id = ? AND is_customer = 1 AND is_deleted = 0",
      [id]
    );
    return result;
  }

  //get a customer by id and user id
  static async getCustomerByIdAndUserId(user_id, account_id) {
    const [[result]] = await pool.query(
      "SELECT * FROM accounts WHERE account_id = ? AND user_id = ? AND is_customer = 1 AND is_deleted = 0",
      [account_id, user_id]
    );
    return result;
  }

  //create a customer related to user
  static async createCustomerByUserId(user_id, data) {
    data.is_customer = 1;
    data.user_id = user_id;
    const [result] = await pool.query("INSERT INTO accounts SET ?", data);
    return result;
  }

  //update a customer related to user
  static async updateCustomerByUserId(user_id, account_id, data) {
    const [result] = await pool.query(
      "UPDATE accounts SET ? WHERE account_id = ? AND user_id = ? AND is_customer = 1 AND is_deleted = 0",
      [data, account_id, user_id]
    );
    return result;
  }

  //delete a customer related to user
  static async deleteCustomerByUserId(user_id, account_id) {
    const [result] = await pool.query(
      "UPDATE accounts SET is_deleted = 1 WHERE account_id = ? AND user_id = ? AND is_customer = 1",
      [account_id, user_id]
    );
    return result;
  }
}

module.exports = Customer;
