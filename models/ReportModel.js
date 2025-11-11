const pool = require("../config/database");
const Accounts = require("./AccountsModel");

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

	// ***************************** New Reports *****************************

	// get revenue
	static async getRevenue(startDate, endDate, user_id) {
		let query = `SELECT
            COALESCE(SUM(soi.quantity * soi.unit_price), 0) AS totalSale,
            COALESCE(SUM(soi.quantity * CASE WHEN soi.avg_cost = 0 OR soi.avg_cost IS NULL THEN soi.unit_cost ELSE soi.avg_cost END), 0) AS totalCost,
            COALESCE(SUM(soi.quantity * (soi.unit_price - CASE WHEN soi.avg_cost = 0 OR soi.avg_cost IS NULL THEN soi.unit_cost ELSE soi.avg_cost END)), 0) AS grossProfit
            FROM
            sales_order_items soi
            JOIN
            sales_orders so ON soi.order_id = so.order_id
            WHERE
            so.order_datetime BETWEEN ? AND ?
            AND so.user_id = ?
            AND soi.is_deleted = 0`;
		let [[result]] = await pool.query(query, [startDate, endDate, user_id]);

		return result;
	}

	// get returns
	static async getReturns(startDate, endDate, user_id) {
		const query = `SELECT
            COALESCE(SUM(roi.quantity * roi.unit_price), 0) AS totalReturn,
            COALESCE(SUM(roi.quantity * CASE WHEN roi.avg_cost = 0 OR roi.avg_cost IS NULL THEN roi.unit_cost ELSE roi.avg_cost END), 0) AS totalCost,
            COALESCE(SUM(roi.quantity * (roi.unit_price - CASE WHEN roi.avg_cost = 0 OR roi.avg_cost IS NULL THEN roi.unit_cost ELSE roi.avg_cost END)), 0) AS grossReturn
            FROM
            return_order_items roi
            JOIN
            return_orders ro ON roi.order_id = ro.order_id
            WHERE
            ro.order_datetime BETWEEN ? AND ?
            AND ro.user_id = ?
            AND roi.is_deleted = 0`;

		let [[result]] = await pool.query(query, [startDate, endDate, user_id]);

		return result;
	}

	// get total orders and returns
	static async getTotalOrders(startDate, endDate, user_id) {
		const query = `SELECT
    (SELECT COUNT(*) FROM sales_orders WHERE order_datetime BETWEEN ? AND ? AND user_id = ? AND is_deleted = 0) AS total_orders,

	(SELECT COALESCE(SUM(quantity), 0) FROM sales_order_items soi
        INNER JOIN sales_orders so ON so.order_id = soi.order_id
        WHERE so.order_datetime BETWEEN ? AND ? AND user_id = ? AND soi.is_deleted = 0) AS total_items,

    (SELECT COUNT(*) FROM return_orders WHERE order_datetime BETWEEN ? AND ? AND user_id = ? AND is_deleted = 0) AS total_returns;`;

		const [[result]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
			startDate,
			endDate,
			user_id,
			startDate,
			endDate,
			user_id,
		]);

		return result;
	}

	static async getDebts(startDate, endDate, user_id) {
		const query = `
            SELECT
                COALESCE(SUM(total_debts), 0) AS total_debts
            FROM (
                SELECT
                    COALESCE(SUM(ji.debit), 0) AS total_debts
                FROM
                    journal_items ji
                INNER JOIN
                    journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                INNER JOIN
                    accounts a ON ji.partner_id_fk = a.account_id
                WHERE
                    ji.is_deleted = 0
                    AND a.is_customer = 1
                    AND jv.journal_date BETWEEN ? AND ?
                    AND jv.user_id = ?
                GROUP BY
                    ji.partner_id_fk
            ) AS customer_balances;`;
		let [[result]] = await pool.query(query, [startDate, endDate, user_id]);
		return result;
	}

	// get customer payments
	static async getCustomerPayments(startDate, endDate, user_id) {
		const query = `SELECT SUM(total_value) AS total_payments
            FROM journal_vouchers
            WHERE journal_date BETWEEN ? AND ?
            AND user_id = ?
            AND journal_description = 'Payment Received'`;
		let [[result]] = await pool.query(query, [startDate, endDate, user_id]);
		return result;
	}

	static async getCashBalance(startDate, endDate, user_id) {
		const [cashAccount] = await Accounts.getIdByAccountNumber("531");
		const query = `SELECT
        COALESCE(sum(debit) - sum(credit),0) AS balance
        FROM journal_items ji
        where ji.is_deleted = 0
        AND ji.journal_date BETWEEN ? AND ?
        AND ji.user_id = ?
        AND ji.account_id_fk = ?`;
		let [[result]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
			cashAccount.id,
		]);
		return result;
	}

	static async getManualCashTransactions(startDate, endDate, user_id) {
		const [cashAccount] = await Accounts.getIdByAccountNumber("531");
		const query = `SELECT
        sum(debit) as total_debit,
        sum(credit) as total_credit,
        COALESCE(sum(debit) - sum(credit),0) AS balance
        FROM journal_items ji
        WHERE ji.is_deleted = 0
        AND ji.reference_number = 'manual'
		AND ji.journal_date BETWEEN ? AND ?
        AND ji.user_id = ?
        AND ji.account_id_fk = ?`;
		let [[result]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
			cashAccount.id,
		]);
		return result;
	}

	// get total expenses
	static async getExpenses(startDate, endDate, user_id) {
		let query = `SELECT
        SUM(debit) AS totalExpenses
        FROM journal_items
        WHERE DATE(journal_date) >= ?
        AND DATE(journal_date) <= ?
        AND user_id = ?
        AND account_id_fk = 8;`;

		let [[results]] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
		]);

		return results;
	}

	// get total supplier payments
	static async getSupplierPayments(startDate, endDate, user_id) {
		let query = `SELECT
        SUM(total_value) AS totalSupplierPayments
        FROM journal_vouchers
        WHERE DATE(journal_date) BETWEEN ? AND ?
        AND user_id = ?
        AND journal_number LIKE 'REC%'
		AND is_deleted = 0
        UNION
        SELECT SUM(credit) AS supplier_payments
        FROM journal_items ji
        JOIN journal_vouchers jv ON ji.journal_id_fk = jv.journal_id
        WHERE account_id_fk = 7
        AND DATE(ji.journal_date) BETWEEN ? AND ?
        AND ji.user_id = ?
        AND journal_description = 'Supplier Payment';`;

		let [results] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
			startDate,
			endDate,
			user_id,
		]);

		return results;
	}

	// get top sales
	static async getTopSales(startDate, endDate, id, user_id) {
		let query = `SELECT p.*, c.category_name,
                SUM(soi.quantity) AS count FROM sales_order_items soi
                INNER JOIN products p  ON soi.product_id  = p.product_id
				LEFT JOIN products_categories c ON p.category_id_fk = c.category_id
                WHERE soi.order_id IN

                (SELECT so.order_id FROM sales_orders so
                    WHERE DATE(so.order_datetime) >= ?
                    AND DATE(so.order_datetime) <= ?
					AND so.user_id = ?
                    AND so.is_deleted = 0)`;

		if (id != "null") {
			query += ` AND p.product_id = ? `;
		}
		query += `GROUP BY p.product_id
                ORDER BY count DESC;`;
		let [results] = await pool.query(query, [
			startDate,
			endDate,
			user_id,
			id,
		]);
		return results;
	}

	static async getTopCategories(startDate, endDate, user_id) {
		let query = `SELECT PC.category_name,
        SUM(SOI.quantity) AS count FROM sales_orders SO
        INNER JOIN sales_order_items SOI ON SO.order_id = SOI.order_id

        INNER JOIN products P ON P.product_id  = SOI.product_id
        INNER JOIN products_categories PC ON PC.category_id  = P.category_id_fk
        WHERE SO.is_deleted = 0
        AND DATE(SO.order_datetime) >= ?
        AND DATE (SO.order_datetime) <= ?
		AND SO.user_id = ?
        GROUP BY PC.category_name
        ORDER BY count DESC
        LIMIT 10
    `;
		let [results] = await pool.query(query, [startDate, endDate, user_id]);
		return results;
	}

	// sales analytics
	// static async getSalesAnalytics(startDate, endDate) {
	// 	const query = `SELECT
	//         p.product_id,
	//         p.sku,
	//         p.product_name,
	//         COALESCE(pur.total_purchased, 0) AS total_purchased,
	//         COALESCE(added.quantity, 0) AS total_added,

	//         COALESCE(removed.quantity, 0) AS total_removed,
	//         COALESCE(sal.total_sold, 0) AS total_sold,

	//         COALESCE(pur.total_purchased, 0) + COALESCE(added.quantity, 0)  - COALESCE(removed.quantity, 0) - COALESCE(sal.total_sold, 0) AS remaining_stock,

	//         COALESCE(it.stock_quantity, 0) AS actual_stock
	//     FROM products p

	//     LEFT JOIN (
	//             SELECT
	//                 poi.product_id_fk,
	//                 SUM(poi.quantity) AS total_purchased
	//             FROM purchase_order_items poi
	//             INNER JOIN purchase_orders po ON po.order_id = poi.order_id_fk
	//             WHERE poi.is_deleted = 0 AND po.is_deleted = 0 AND DATE(po.order_datetime) BETWEEN ? AND ?
	//             GROUP BY poi.product_id_fk
	//         ) pur ON pur.product_id_fk = p.product_id AND p.stock_management = 1

	//     LEFT JOIN (
	//     	SELECT
	//                 product_id_fk,
	//                 + SUM(CASE WHEN transaction_type = 'ADD' THEN quantity ELSE 0 END)
	//                 AS quantity
	//             FROM inventory_transactions
	//             WHERE is_deleted = 0 AND DATE(transaction_datetime) BETWEEN ? AND ?
	//             GROUP BY product_id_fk
	//     	) added ON p.product_id = added.product_id_fk AND p.stock_management = 1

	//     LEFT JOIN (
	//         SELECT
	//                 product_id_fk,
	//                 + SUM(CASE WHEN transaction_type = 'DELETE' THEN quantity ELSE 0 END)
	//                 AS quantity
	//             FROM inventory_transactions
	//             WHERE is_deleted = 0 AND DATE(transaction_datetime) BETWEEN ? AND ?
	//             GROUP BY product_id_fk
	//         ) deleted ON p.product_id = deleted.product_id_fk AND p.stock_management = 1

	//     LEFT JOIN (
	//         SELECT
	//             product_id_fk,
	//             SUM(CASE WHEN transaction_type = 'REMOVE' THEN ABS(quantity) ELSE 0 END)
	//             AS quantity
	//         FROM inventory_transactions
	//         WHERE is_deleted = 0 AND DATE(transaction_datetime) BETWEEN ? AND ?
	//         GROUP BY product_id_fk
	//     ) removed ON p.product_id = removed.product_id_fk AND p.stock_management = 1

	//     LEFT JOIN (
	//         SELECT
	//             soi.product_id,
	//             SUM(soi.quantity) AS total_sold
	//         FROM sales_order_items soi
	//         INNER JOIN sales_orders so ON so.order_id = soi.order_id
	//         WHERE soi.is_deleted = 0 AND so.is_deleted = 0 AND DATE(so.order_datetime) BETWEEN ? AND ?
	//         GROUP BY soi.product_id
	//     ) sal ON sal.product_id = p.product_id AND p.stock_management = 1

	//     LEFT JOIN (
	//         SELECT product_id_fk, SUM(quantity) AS stock_quantity
	//         FROM inventory_transactions
	//         GROUP BY product_id_fk
	//     ) it ON it.product_id_fk = p.product_id AND p.stock_management = 1

	//     WHERE p.is_deleted = 0
	//     AND p.stock_management = 1
	//     HAVING
	//         COALESCE(total_purchased, 0) > 0
	//         OR COALESCE(total_added, 0) > 0
	//         OR COALESCE(total_removed, 0) > 0
	//         OR COALESCE(total_sold, 0) > 0
	//     ORDER BY p.product_id`;

	// 	let [results] = await pool.query(query, [
	// 		startDate,
	// 		endDate,
	// 		startDate,
	// 		endDate,
	// 		startDate,
	// 		endDate,
	// 		startDate,
	// 		endDate,
	// 		startDate,
	// 		endDate,
	// 	]);

	// 	return results;
	// }
}

module.exports = ReportModel;
