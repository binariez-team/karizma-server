const pool = require("../config/database");
const Accounts = require("../models/AccountsModel");
const moment = require("moment-timezone");

class Expense {
	// get expense details
	static async getExpenseDetails(expenseNumber, startDate, endDate, user_id) {
		// cash account
		const [_531] = await Accounts.getIdByAccountNumber("531");

		// params
		const params = [user_id];
		params.push(_531.id);
		let sql = `SELECT
        jv.journal_id,
        jv.journal_number,
        jv.journal_description,
        jv.journal_date as payment_date,
        jv.total_value,
        ji.account_id_fk

        FROM journal_vouchers jv

        INNER JOIN journal_items ji ON jv.journal_id = ji.journal_id_fk

		WHERE jv.user_id = ?
        AND ji.account_id_fk != ?
        AND ji.is_deleted = 0`;

		if (expenseNumber) {
			sql += ` AND jv.journal_number LIKE ?`;
			if (expenseNumber.substr(0, 3) === "EXP") {
				params.push(`%${expenseNumber}`);
			} else {
				params.push(`%EXP${expenseNumber}`);
			}
		} else {
			sql += ` AND jv.journal_number LIKE 'EXP%' `;
		}
		if (startDate) {
			sql += ` AND DATE(jv.journal_date) >= ? `;
			params.push(startDate);
		}
		if (endDate) {
			sql += ` AND DATE(jv.journal_date) <= ? `;
			params.push(endDate);
		}

		sql += ` ORDER BY payment_date DESC `;
		if (expenseNumber || startDate || endDate) {
			// do nothing now for LIMITING (no limit)
		} else {
			sql += ` LIMIT 100`;
		}

		const [expenses] = await pool.query(sql, params);
		return expenses;
	}

	// get expense accounts
	static async getExpenseAccounts() {
		const accounts = await Accounts.getAccountsByAccountNumber("6112%");
		return accounts;
	}

	// create expense
	static async createExpense(user_id, paymentData) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			paymentData.payment_date = moment(paymentData.payment_date).format(
				`YYYY-MM-DD HH:mm:ss`
			);

			let [[{ number }]] = await connection.query(
				`SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'EXP%'`
			);

			let payment_number = `EXP${number.toString().padStart(4, "0")}`;

			//insert to vouchers and journal_items
			let query = `INSERT INTO journal_vouchers (journal_number, journal_date, journal_description, total_value, user_id) VALUES (?, ?, ?, ?, ?)`;
			const [journal_voucher] = await connection.query(query, [
				payment_number,
				paymentData.payment_date,
				paymentData.journal_description,
				paymentData.amount,
				user_id,
			]);

			let [_531] = await Accounts.getIdByAccountNumber("531");

			const cashAccount = {
				user_id: user_id,
				journal_id_fk: journal_voucher.insertId,
				journal_date: paymentData.payment_date,
				account_id_fk: _531.id,
				reference_number: paymentData.reference_number,
				partner_id_fk: null,
				debit: 0,
				credit: paymentData.amount,
				// notes: paymentData.journal_description,
			};
			await connection.query(
				`INSERT INTO journal_items SET ?`,
				cashAccount
			);

			let [_6112] = await Accounts.getIdByAccountNumber("6112");

			const secondItem = {
				user_id: user_id,
				journal_id_fk: journal_voucher.insertId,
				journal_date: paymentData.payment_date,
				account_id_fk: _6112.id,
				reference_number: paymentData.reference_number,
				partner_id_fk: null,
				debit: paymentData.amount,
				credit: 0,
			};
			await connection.query(
				`INSERT INTO journal_items SET ?`,
				secondItem
			);

			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	// update expense
	static async updateExpense(user_id, paymentData) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			// paymentData.payment_date = moment(paymentData.payment_date).format(
			// 	`YYYY-MM-DD HH:mm:ss`
			// );

			// update journal vouchers and journal items
			let query = `UPDATE journal_vouchers SET journal_description = ?, total_value = ? WHERE journal_id = ? AND user_id = ?`;
			await connection.query(query, [
				// paymentData.payment_date,
				paymentData.journal_description,
				paymentData.amount,
				paymentData.journal_id,
				user_id,
			]);

			let [_531] = await Accounts.getIdByAccountNumber("531");

			await connection.query(
				`UPDATE journal_items SET credit = ? WHERE journal_id_fk = ? AND account_id_fk = ?`,
				[
					paymentData.amount,
					// paymentData.payment_date,
					// paymentData.journal_description,
					paymentData.journal_id,
					_531.id,
				]
			);

			let [_6112] = await Accounts.getIdByAccountNumber("6112");
			await connection.query(
				`UPDATE journal_items SET debit = ?, account_id_fk = ? WHERE journal_id_fk = ? AND account_id_fk != ?`,
				[
					paymentData.amount,
					// paymentData.payment_date,
					_6112.id,
					paymentData.journal_id,
					_531.id,
				]
			);

			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	// delete expense
	static async deleteExpense(user_id, journal_id) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			await connection.query(
				`DELETE FROM journal_items WHERE journal_id_fk = ? AND user_id = ?`,
				[journal_id, user_id]
			);

			await connection.query(
				`DELETE FROM journal_vouchers WHERE journal_id = ? AND user_id = ?`,
				[journal_id, user_id]
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

module.exports = Expense;
