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

	//get customer latest purchases
	static async getCustomerLatestPurchases(user_id, account_id) {
		const [result] = await pool.query(
			`  SELECT
            customer_id,
            product_id,
            order_id,
            order_datetime,
            unit_price,
            price_type
            FROM (
                 SELECT
                i.customer_id,
                im.product_id,
                i.order_id,
                i.order_datetime,
                im.unit_price,
                im.price_type,

                ROW_NUMBER() OVER (PARTITION BY im.product_id, im.price_type ORDER BY i.order_datetime DESC) AS purchase_rank
            FROM
                sales_orders i
            JOIN
                sales_order_items im ON i.order_id = im.order_id
                LEFT JOIN
                	accounts a ON a.account_id = i.customer_id
                WHERE
                    a.user_id = ?  AND i.customer_id = ?
            ) ranked_purchases
            WHERE
                purchase_rank <= 3;`,
			[user_id, account_id]
		);
		return result;
	}
}

module.exports = Customer;
