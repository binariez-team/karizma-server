const pool = require("../config/database");
const Accounts = require("./AccountsModel");
const moment = require("moment-timezone");

class ReportModel {
    // get stock value
    static async getStockValue(database_id) {
        const query = `SELECT
            SUM(T.quantity * I.avg_cost_usd) AS cost_value_usd,
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
			WHERE database_id = ?
            GROUP BY product_id_fk
        ) T ON P.product_id = T.product_id_fk
		LEFT JOIN inventory I ON I.product_id_fk = P.product_id
        WHERE P.is_deleted = 0
		AND I.database_id = ?
        AND T.quantity > 0`;
        let [[result]] = await pool.query(query, [database_id, database_id]);

        return result;
    }

    // ***************************** New Reports *****************************

    // get revenue
    static async getRevenue(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        let query = `SELECT
            COALESCE(SUM(soi.quantity * soi.unit_price), 0) AS totalSale,
            COALESCE(SUM(soi.quantity * CASE WHEN soi.avg_cost = 0 OR soi.avg_cost IS NULL THEN soi.unit_cost ELSE soi.avg_cost END), 0) AS totalCost,
            COALESCE(SUM(soi.quantity * (soi.unit_price - CASE WHEN soi.avg_cost = 0 OR soi.avg_cost IS NULL THEN soi.unit_cost ELSE soi.avg_cost END)), 0) AS grossProfit
            FROM
            sales_order_items soi
            JOIN
            sales_orders so ON soi.order_id = so.order_id
            WHERE
            DATE(so.order_datetime) BETWEEN ? AND ?
            AND so.database_id = ?
            AND soi.is_deleted = 0`;
        let [[result]] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
        ]);

        return result;
    }

    // get returns
    static async getReturns(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        const query = `SELECT
            COALESCE(SUM(roi.quantity * roi.unit_price), 0) AS totalReturn,
            COALESCE(SUM(roi.quantity * CASE WHEN roi.avg_cost = 0 OR roi.avg_cost IS NULL THEN roi.unit_cost ELSE roi.avg_cost END), 0) AS totalCost,
            COALESCE(SUM(roi.quantity * (roi.unit_price - CASE WHEN roi.avg_cost = 0 OR roi.avg_cost IS NULL THEN roi.unit_cost ELSE roi.avg_cost END)), 0) AS grossReturn
            FROM
            return_order_items roi
            JOIN
            return_orders ro ON roi.order_id = ro.order_id
            WHERE
            DATE(ro.order_datetime) BETWEEN ? AND ?
            AND ro.database_id = ?
            AND roi.is_deleted = 0`;

        let [[result]] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
        ]);

        return result;
    }

    // get total orders and returns
    static async getTotalOrders(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");
        const query = `SELECT
    (SELECT COUNT(*) FROM sales_orders WHERE order_datetime BETWEEN ? AND ? AND database_id = ? AND is_deleted = 0) AS total_orders,

	(SELECT COALESCE(SUM(quantity), 0) FROM sales_order_items soi
        INNER JOIN sales_orders so ON so.order_id = soi.order_id
        WHERE DATE(so.order_datetime) BETWEEN ? AND ? AND database_id = ? AND soi.is_deleted = 0) AS total_items,

    (SELECT COUNT(*) FROM return_orders WHERE DATE(order_datetime) BETWEEN ? AND ? AND database_id = ? AND is_deleted = 0) AS total_returns;`;

        const [[result]] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
            start_date,
            end_date,
            database_id,
            start_date,
            end_date,
            database_id,
        ]);

        return result;
    }

    static async getDebts(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        const query = `
            SELECT
                COALESCE(SUM(total_debts), 0) AS total_debts
            FROM (
                SELECT
                    COALESCE(SUM(ji.debit) - SUM(ji.credit), 0) AS total_debts
                FROM
                    journal_items ji
                INNER JOIN
                    journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                INNER JOIN
                    accounts a ON ji.partner_id_fk = a.account_id
                WHERE
                    ji.is_deleted = 0
					AND jv.is_deleted = 0
                    AND a.is_customer = 1
					AND a.is_deleted = 0
                    AND DATE(jv.journal_date) BETWEEN ? AND ?
                    AND jv.database_id = ?
                GROUP BY
                    ji.partner_id_fk
            ) AS customer_balances;`;
        let [[result]] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
        ]);

        return result;
    }

    // get customer payments
    static async getCustomerPayments(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        const query = `SELECT SUM(total_value) AS total_payments
            FROM journal_vouchers
            WHERE DATE(journal_date) BETWEEN ? AND ?
            AND database_id = ?
            AND journal_description = 'Payment Received'`;
        let [[result]] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
        ]);
        return result;
    }

    static async getCashBalance(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        const [cashAccount] = await Accounts.getIdByAccountNumber("531");
        const [whishAccount] = await Accounts.getIdByAccountNumber("532");
        const query = `SELECT
        COALESCE(sum(debit) - sum(credit),0) AS balance
        FROM journal_items ji
        where ji.is_deleted = 0
        AND DATE(ji.journal_date) BETWEEN ? AND ?
        AND ji.database_id = ?
        AND (ji.account_id_fk = ? OR ji.account_id_fk = ?)`;
        let [[result]] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
            cashAccount.id,
            whishAccount.id,
        ]);
        return result;
    }

    static async getManualCashTransactions(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        const [cashAccount] = await Accounts.getIdByAccountNumber("531");
        const query = `SELECT
        sum(debit) as total_debit,
        sum(credit) as total_credit,
        COALESCE(sum(debit) - sum(credit),0) AS balance
        FROM journal_items ji
        WHERE ji.is_deleted = 0
        AND ji.reference_number = 'manual'
		AND DATE(ji.journal_date) BETWEEN ? AND ?
        AND ji.database_id = ?
        AND ji.account_id_fk = ?`;
        let [[result]] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
            cashAccount.id,
        ]);
        return result;
    }

    // get total expenses
    static async getExpenses(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        const query = `SELECT
		SUM(total_value) AS totalExpenses
		FROM journal_vouchers
		WHERE database_id = ?
		AND DATE(journal_date) BETWEEN ? AND ?
		AND is_deleted = 0 AND journal_number LIKE 'EXP%'`;

        let [[results]] = await pool.query(query, [
            database_id,
            start_date,
            end_date,
        ]);

        return results;
    }

    // get total supplier payments
    static async getSupplierPayments(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        let query = `SELECT
        SUM(total_value) AS totalSupplierPayments
        FROM journal_vouchers
        WHERE DATE(journal_date) BETWEEN ? AND ?
        AND database_id = ?
        AND journal_number LIKE 'REC%'
		AND is_deleted = 0
        UNION
        SELECT SUM(credit) AS supplier_payments
        FROM journal_items ji
        JOIN journal_vouchers jv ON ji.journal_id_fk = jv.journal_id
        WHERE account_id_fk = 7
        AND DATE(ji.journal_date) BETWEEN ? AND ?
        AND ji.database_id = ?
        AND journal_description = 'Supplier Payment';`;

        let [results] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
            start_date,
            end_date,
            database_id,
        ]);

        return results;
    }

    // get top sales
    static async getTopSales(startDate, endDate, id, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        let query = `SELECT p.*, c.category_name,
                SUM(soi.quantity) AS count FROM sales_order_items soi
                INNER JOIN products p  ON soi.product_id  = p.product_id
				LEFT JOIN products_categories c ON p.category_id_fk = c.category_id
                WHERE soi.order_id IN

                (SELECT so.order_id FROM sales_orders so
                    WHERE DATE(so.order_datetime) >= ?
                    AND DATE(so.order_datetime) <= ?
					AND so.database_id = ?
                    AND so.is_deleted = 0)`;

        if (id != "null") {
            query += ` AND p.product_id = ? `;
        }
        query += `GROUP BY p.product_id
                ORDER BY count DESC;`;
        let [results] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
            id,
        ]);
        return results;
    }

    static async getTopCategories(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        let query = `SELECT PC.category_name,
        SUM(SOI.quantity) AS count FROM sales_orders SO
        INNER JOIN sales_order_items SOI ON SO.order_id = SOI.order_id

        INNER JOIN products P ON P.product_id  = SOI.product_id
        INNER JOIN products_categories PC ON PC.category_id  = P.category_id_fk
        WHERE SO.is_deleted = 0
        AND DATE(SO.order_datetime) >= ?
        AND DATE (SO.order_datetime) <= ?
		AND SO.database_id = ?
        GROUP BY PC.category_name
        ORDER BY count DESC
        LIMIT 10
    `;
        let [results] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
        ]);
        return results;
    }

    static async getDisposes(startDate, endDate, database_id) {
        const start_date = moment(startDate)
            .tz("Asia/Beirut")
            .format("YYYY-MM-DD");
        const end_date = moment(endDate).tz("Asia/Beirut").format("YYYY-MM-DD");

        const query = `SELECT SUM(total_cost) total_disposes
		FROM dispose_products
		WHERE DATE(dispose_datetime) BETWEEN ? AND ? 
		AND database_id = ?
		AND is_deleted = 0`;

        let [[results]] = await pool.query(query, [
            start_date,
            end_date,
            database_id,
        ]);

        return results;
    }
}

module.exports = ReportModel;
