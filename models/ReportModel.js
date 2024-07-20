const pool = require("../config/database");

class ReportModel {
	static async getTotalSales(user_id, startDate, endDate) {
		let query = `SELECT
        COALESCE(SUM(total_amount),0) AS totalSale,
        COALESCE(SUM(total_cost), 0) AS totalCost,
        COALESCE(SUM(total_amount - total_cost),0) AS grossProfit
        FROM sales_orders
        WHERE DATE(order_datetime) >= ?
        AND DATE(order_datetime) <= ?
        AND user_id = ?
        AND is_deleted = 0`;
		let [[result]] = await pool.query(query, [startDate, endDate, user_id]);
		return result;
	}

	static async getTotalPayments(user_id, startDate, endDate) {
		let query = `
        SELECT
        COALESCE(sum(total_value), 0) as totalPayment
        FROM journal_vouchers P
        WHERE P.is_deleted = 0 
        AND DATE(P.journal_date) BETWEEN ? AND ?
        AND P.user_id = ?
        AND journal_description = 'Payment';`;
		let [[result]] = await pool.query(query, [startDate, endDate, user_id]);
		return result;
	}
}

module.exports = ReportModel;
