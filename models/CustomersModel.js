const pool = require("../config/database");
const Accounts = require("./AccountsModel");
const moment = require("moment-timezone");

class Customer {
	// get customers debts
	static async getCustomerDebts(user_id) {
		let query = `SELECT
			a.account_id,
			a.name,
			a.phone,
			COALESCE(SUM(ji.debit) - SUM(ji.credit), 0) AS balance
		FROM
			journal_items ji
		LEFT JOIN
			journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
		INNER JOIN
			accounts a ON ji.partner_id_fk = a.account_id
		WHERE
			ji.is_deleted = 0
			AND jv.user_id = ?        
			AND a.is_customer = 1
			AND a.is_deleted = 0
		GROUP BY
			ji.partner_id_fk
		HAVING
			balance != 0
		ORDER BY
			balance DESC;`;
		const [result] = await pool.query(query, [user_id]);

		return result;
	}

	// update customer debts
	static async addManualDebt(data, user_id) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			data.transaction_datetime = moment(
				data.transaction_datetime
			).format(`YYYY-MM-DD HH:mm:ss`);

			// create journal voucher
			let query = `INSERT INTO journal_vouchers (user_id, journal_date, journal_description, journal_notes, total_value) VALUES (?, ?, ?, ?, ?)`;
			const [journal_voucher] = await connection.query(query, [
				user_id,
				data.transaction_datetime,
				"Manual Transaction",
				data.transaction_notes,
				data.amount,
			]);

			let [_4111] = await Accounts.getIdByAccountNumber("4111");
			const ordinaryClients = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: data.transaction_datetime,
				account_id_fk: _4111.id,
				partner_id_fk: data.selected_account,
				user_id: user_id,
				debit: 0,
				credit: 0,
			};

			let capitalOrCash;
			if (data.modifyCash) {
				let [_531] = await Accounts.getIdByAccountNumber("531");
				capitalOrCash = {
					journal_id_fk: journal_voucher.insertId,
					journal_date: data.transaction_datetime,
					account_id_fk: _531.id,
					reference_number: data.transaction_notes,
					partner_id_fk: null,
					user_id: user_id,
					debit: 0,
					credit: 0,
				};
			} else {
				let [_101] = await Accounts.getIdByAccountNumber("101");
				capitalOrCash = {
					journal_id_fk: journal_voucher.insertId,
					journal_date: data.transaction_datetime,
					account_id_fk: _101.id,
					reference_number: data.reference_number,
					partner_id_fk: null,
					user_id: user_id,
					debit: 0,
					credit: 0,
				};
			}

			// debit or credit based on transaction type
			if (data.transaction_type == "ADD") {
				ordinaryClients.debit = data.amount;
				capitalOrCash.credit = data.amount;
			} else {
				ordinaryClients.credit = data.amount;
				capitalOrCash.debit = data.amount;
			}

			// add journal items
			await connection.query(
				`INSERT INTO journal_items SET ?`,
				ordinaryClients
			);
			await connection.query(
				`INSERT INTO journal_items SET ?`,
				capitalOrCash
			);

			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
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

	// get customer name
	static async getCustomerNameById(account_id) {
		const [[{ name }]] = await pool.query(
			`SELECT name FROM accounts WHERE account_id = ? AND is_deleted = 0`,
			[account_id]
		);

		return name;
	}

	//create a customer related to user
	static async createCustomerByUserId(user_id, data) {
		data.is_customer = 1;
		data.user_id = user_id;
		const [result] = await pool.query("INSERT INTO accounts SET ?", data);
		return result;
	}

	//update a customer related to user
	static async updateCustomerByUserId(user_id, data) {
		const [result] = await pool.query(
			"UPDATE accounts SET ? WHERE account_id = ? AND user_id = ? AND is_customer = 1 AND is_deleted = 0",
			[data, data.account_id, user_id]
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

                ROW_NUMBER() OVER (PARTITION BY im.product_id ORDER BY i.order_datetime DESC) AS purchase_rank
            FROM
                sales_orders i
            JOIN
                sales_order_items im ON i.order_id = im.order_id
                LEFT JOIN
                	accounts a ON a.account_id = i.customer_id
                WHERE
                    a.user_id = ?  AND i.customer_id = ? AND im.is_deleted = 0
            ) ranked_purchases
            WHERE
                purchase_rank <= 1;`,
			[user_id, account_id]
		);
		return result;
	}

	static async getCustomerTotalBalance(user_id, account_id) {
		const query = `SELECT 
					COALESCE(SUM(ji.debit) - SUM(ji.credit), 0) AS balance
				FROM 
					journal_vouchers jv
				LEFT JOIN 
					journal_items ji ON jv.journal_id = ji.journal_id_fk
				WHERE 
					ji.partner_id_fk = ?
					AND jv.user_id = ?
					AND ji.is_deleted = 0`;
		const [[result]] = await pool.query(query, [account_id, user_id]);
		return result;
	}
}

module.exports = Customer;
