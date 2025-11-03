const pool = require("../config/database");
const Accounts = require("./AccountsModel");
const moment = require("moment-timezone");

class Payment {
	static async addCustomerPayment(user_id, paymentData) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			paymentData.payment_date = moment(paymentData.payment_date).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);

			let [[{ number }]] = await connection.query(
				`SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'PAY%'`
			);

			let payment_number = `PAY${number.toString().padStart(4, "0")}`;

			//insert to vouchers and journal_items
			let query = `INSERT INTO journal_vouchers ( user_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
			const [journal_voucher] = await connection.query(query, [
				user_id,
				payment_number,
				paymentData.payment_date,
				"Payment Received",
				paymentData.amount,
			]);

			let [_531] = await Accounts.getIdByAccountNumber("531");

			const firstItem = {
				user_id: user_id,
				journal_id_fk: journal_voucher.insertId,
				journal_date: paymentData.payment_date,
				account_id_fk: _531.id,
				reference_number: paymentData.reference_number,
				partner_id_fk: null,
				debit: paymentData.amount,
				credit: 0,
			};

			await connection.query(
				`INSERT INTO journal_items SET ?`,
				firstItem
			);

			let [_413] = await Accounts.getIdByAccountNumber("413");
			const secondItem = {
				user_id: user_id,
				journal_id_fk: journal_voucher.insertId,
				journal_date: paymentData.payment_date,
				account_id_fk: _413.id,
				reference_number: paymentData.reference_number,
				partner_id_fk: paymentData.account_id,
				debit: 0,
				credit: paymentData.amount,
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

	static async editCustomerPayment(user_id, paymentData) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			paymentData.payment_date = moment(paymentData.payment_date).format(
				`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
			);

			//insert to vouchers and journal_items
			let query = `UPDATE journal_vouchers SET total_value = ? WHERE journal_id = ? and user_id = ?`;
			const [journal_voucher] = await connection.query(query, [
				paymentData.amount,
				paymentData.journal_id,
				user_id,
			]);

			let [_531] = await Accounts.getIdByAccountNumber("531");

			await connection.query(
				`UPDATE journal_items SET debit = ?, journal_date = ? WHERE journal_id_fk = ? AND account_id_fk = ?`,
				[
					paymentData.amount,
					paymentData.payment_date,
					paymentData.journal_id,
					_531.id,
				]
			);

			let [_413] = await Accounts.getIdByAccountNumber("413");

			await connection.query(
				`UPDATE journal_items SET credit = ?, journal_date = ? WHERE journal_id_fk = ? AND account_id_fk = ?`,
				[
					paymentData.amount,
					paymentData.payment_date,
					paymentData.journal_id,
					_413.id,
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

	static async deletePayment(user_id, journal_id) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			let [journal_items] = await connection.query(
				`SELECT journal_item_id FROM journal_items ji
                inner join journal_vouchers jv 
                ON jv.journal_id = ji.journal_id_fk 
                WHERE journal_id_fk = ? AND jv.user_id = ?`,
				[journal_id, user_id]
			);
			journal_items = journal_items.map((item) => item.journal_item_id);

			await connection.query(
				`UPDATE journal_items SET is_deleted = 1 WHERE journal_item_id in (?)`,
				[journal_items]
			);

			await connection.query(
				`UPDATE journal_vouchers SET is_deleted = 1 WHERE journal_id = ? AND user_id = ?`,
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

	static async addSupplierPayment(user_id, paymentData) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			paymentData.payment_date = moment(paymentData.payment_date).format(
				`YYYY-MM-DD HH:mm:ss`
			);

			let [[{ number }]] = await connection.query(
				`SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'REC%'`
			);

			let payment_number = `REC${number.toString().padStart(4, "0")}`;

			//insert to vouchers and journal_items
			let query = `INSERT INTO journal_vouchers (user_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
			const [journal_voucher] = await connection.query(query, [
				user_id,
				payment_number,
				paymentData.payment_date,
				"Supplier Payment",
				paymentData.amount,
			]);

			let [_531] = await Accounts.getIdByAccountNumber("531");

			const firstItem = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: paymentData.payment_date,
				account_id_fk: _531.id,
				reference_number: paymentData.reference_number,
				debit: 0,
				credit: paymentData.amount,
				user_id: user_id,
			};

			await connection.query(
				`INSERT INTO journal_items SET ?`,
				firstItem
			);

			let [_401] = await Accounts.getIdByAccountNumber("401");
			const secondItem = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: paymentData.payment_date,
				account_id_fk: _401.id,
				reference_number: paymentData.reference_number,
				partner_id_fk: paymentData.account_id,
				debit: paymentData.amount,
				credit: 0,
				user_id: user_id,
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

	// edit payment
	static async editSupplierPayment(user_id, paymentData) {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();

			moment.tz.setDefault("Asia/Beirut");
			paymentData.payment_date = moment(paymentData.payment_date).format(
				`YYYY-MM-DD HH:mm:ss`
			);

			//insert to vouchers and journal_items
			let query = `UPDATE journal_vouchers SET total_value = ? WHERE journal_id = ? AND user_id = ?`;
			const [journal_voucher] = await connection.query(query, [
				paymentData.amount,
				paymentData.journal_id,
				user_id,
			]);

			let [_531] = await Accounts.getIdByAccountNumber("531");

			await connection.query(
				`UPDATE journal_items SET credit = ?, journal_date = ? WHERE journal_id_fk = ? AND account_id_fk = ?`,
				[
					paymentData.amount,
					paymentData.payment_date,
					paymentData.journal_id,
					_531.id,
				]
			);

			let [_401] = await Accounts.getIdByAccountNumber("401");

			await connection.query(
				`UPDATE journal_items SET debit = ?, journal_date = ? WHERE journal_id_fk = ? AND account_id_fk= ?`,
				[
					paymentData.amount,
					paymentData.payment_date,
					paymentData.journal_id,
					_401.id,
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
}
module.exports = Payment;
