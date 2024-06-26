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

			//insert to vouchers and journal_items
			let query = `INSERT INTO journal_vouchers ( user_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
			const [journal_voucher] = await connection.query(query, [
				user_id,
				null,
				paymentData.payment_date,
				"Customer Payment",
				paymentData.amount,
			]);

			let [_531] = await Accounts.getIdByAccountNumber("531");

			const firstItem = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: paymentData.payment_date,
				account_id_fk: _531.id,
				reference_number: paymentData.reference_number,
				partner_id_fk: null,
				currency: "USD",
				debit: 0,
				credit: paymentData.amount,
				exchange_value: paymentData.exchange_rate,
			};

			await connection.query(`INSERT INTO journal_items SET ?`, firstItem);

			let [_413] = await Accounts.getIdByAccountNumber("413");
			const secondItem = {
				journal_id_fk: journal_voucher.insertId,
				journal_date: paymentData.payment_date,
				account_id_fk: _413.id,
				reference_number: paymentData.reference_number,
				partner_id_fk: paymentData.customer_id,
				currency: "USD",
				debit: paymentData.amount,
				credit: 0,
				exchange_value: paymentData.exchange_rate,
			};
			await connection.query(`INSERT INTO journal_items SET ?`, secondItem);

			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}
	static async addSupplierPayment(paymentData) {}
}
module.exports = Payment;
