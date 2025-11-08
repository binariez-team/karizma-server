const pool = require("../config/database");

class ReportModel {
	static async getTotalSales(user_id, startDate, endDate) {
		let query = `SELECT
                COALESCE(SUM(total_amount), 0) AS totalSale,
                COALESCE(SUM(total_cost), 0) AS totalCost,
                COALESCE(SUM(total_amount - total_cost), 0) AS grossProfit
            FROM
                sales_orders
            WHERE
                DATE(order_datetime) >= ?
                AND DATE(order_datetime) <= ?
                AND user_id = ?
                AND is_deleted = 0`;
		let [[sales]] = await pool.query(query, [startDate, endDate, user_id]);

		query = `SELECT
                COALESCE(SUM(total_amount), 0) AS totalReturn,
                COALESCE(SUM(total_cost), 0) AS totalReturnCost,
                COALESCE(SUM(total_amount - total_cost), 0) AS grossReturn
            FROM
                return_orders
            WHERE
                DATE(order_datetime) >= ?
                AND DATE(order_datetime) <= ?
                AND user_id = ?
                AND is_deleted = 0`;
		let [[returns]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
		]);

		query = `SELECT
                COALESCE(SUM(total_value), 0) AS totalPayment
            FROM
                journal_vouchers
            WHERE
                DATE(journal_date) >= ?
                AND DATE(journal_date) <= ?
                AND user_id = ?
                AND journal_description = 'Payment Received'
                AND is_deleted = 0`;
		let [[payments]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
		]);

		query = `SELECT
                COALESCE(SUM(total_value), 0) AS totalExpense
            FROM
                journal_vouchers
            WHERE
                DATE(journal_date) >= ?
                AND DATE(journal_date) <= ?
                AND user_id = ?
                AND journal_description = 'Expense'
                AND is_deleted = 0`;
		let [[expenses]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
		]);

		query = `SELECT COALESCE(sum(total_cost),0) AS totalDispose
                FROM dispose_products 
                WHERE DATE(dispose_datetime) BETWEEN ? AND ?
                AND user_id = ? AND is_deleted = 0;`;
		let [[dispose]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
		]);

		query = `SELECT
        COALESCE(SUM(total_value), 0) AS totalMoneyTransfer
        FROM
            journal_vouchers
        WHERE
            DATE(journal_date) >= ?
            AND DATE(journal_date) <= ?
            AND user_id = ?
            AND journal_description = 'Transfer'
            AND is_deleted = 0`;
		let [[moneyTransfer]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
		]);

		return { sales, returns, payments, expenses, dispose, moneyTransfer };
	}

	static async getTotalPayments(user_id, startDate, endDate) {
		console.log(startDate);
		console.log(endDate);
		console.log(user_id);

		let query = `
        SELECT
        COALESCE(sum(total_value), 0) as totalPayment
        FROM journal_vouchers P
        WHERE P.is_deleted = 0 
        AND DATE(P.journal_date) BETWEEN ? AND ?
        AND P.user_id = ?
        AND journal_description = 'Payment Received';`;
		let [[result]] = await pool.query(query, [startDate, endDate, user_id]);
		return result;
	}

	// get stock value
	static async getStockValue(user_id) {
		const query = `SELECT
            SUM(T.quantity * P.unit_cost_usd) AS cost_value_usd,
            SUM(T.quantity * I.unit_price_usd) AS selling_value_usd,
            SUM(T.quantity) AS total_quantity_usd

        FROM products P
        LEFT JOIN (
            SELECT
                product_id_fk,
                SUM(
					CASE WHEN transaction_type IN (
                    'SALE', 'SUPPLY','RETURN','DELETE', 'DISPOSE','DELIVER', 'REVERSERETURN', 'REVERSEDISPOSE', 'REVERSEDELIVER', 'ADD', 'REMOVE'
                )
				THEN quantity ELSE 0
				END
			) AS quantity
            FROM inventory_transactions
			WHERE user_id_fk = ?
            GROUP BY product_id_fk
        ) T ON P.product_id = T.product_id_fk
		LEFT JOIN inventory I ON I.product_id_fk = P.product_id
        WHERE P.is_deleted = 0
		AND I.user_id_fk = ?
        AND T.quantity > 0`;
		let [[result]] = await pool.query(query, [user_id, user_id]);

		return result;
	}
}

module.exports = ReportModel;
