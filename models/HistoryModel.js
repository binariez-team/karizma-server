const pool = require("../config/database");
const moment = require("moment-timezone");
const { ACTOR_COLUMNS, actorJoins } = require("./OrderActors");

class History {
    // get product history
    static async getProductHistoryById(product_id, database_id) {
        const query = `
        SELECT
            final.*,
            A.name AS account_name,
            CASE
                WHEN final.transaction_type = 'DELIVER'
                    THEN UDF.database_name
                ELSE NULL
            END AS 'from',
            CASE
                WHEN final.transaction_type = 'DELIVER'
                    THEN UDT.database_name
                ELSE NULL
            END AS 'to'
        FROM (
            SELECT
                sub.*,
                COALESCE(SO.customer_id, RO.customer_id, PO.partner_id_fk) AS account_id,
                CASE
                    WHEN sub.transaction_type = 'SALE' THEN 'sales_orders'
                    WHEN sub.transaction_type = 'RETURN' THEN 'return_orders'
                    WHEN sub.transaction_type = 'SUPPLY' THEN 'purchase_orders'
                    ELSE NULL
                END AS order_table,
                DO.admin_id_fk   AS from_database_id,
                DO.database_id   AS to_database_id
            FROM (
                SELECT
                    T.*,
                    SUM(T.quantity) OVER (
                        PARTITION BY T.product_id_fk
                        ORDER BY T.transaction_datetime
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS balance
                FROM inventory_transactions T
                WHERE T.product_id_fk = ?
                AND T.database_id = ?
                AND T.is_deleted = 0
            ) AS sub
            LEFT JOIN sales_orders SO
                ON sub.transaction_type = 'SALE'
            AND sub.order_id_fk = SO.order_id
            LEFT JOIN return_orders RO
                ON sub.transaction_type = 'RETURN'
            AND sub.order_id_fk = RO.order_id
            LEFT JOIN purchase_orders PO
                ON sub.transaction_type = 'SUPPLY'
            AND sub.order_id_fk = PO.order_id
            LEFT JOIN deliver_orders DO
                ON sub.transaction_type = 'DELIVER'
            AND sub.order_id_fk = DO.order_id
        ) AS final
        LEFT JOIN accounts A
            ON final.account_id = A.account_id
        LEFT JOIN user_database UDF
            ON final.from_database_id = UDF.database_id
        LEFT JOIN user_database UDT
            ON final.to_database_id = UDT.database_id
        ORDER BY final.transaction_datetime DESC
        LIMIT 10000;
        `;
        let [rows] = await pool.query(query, [product_id, database_id]);
        return rows;
    }

    // fetch order items by order id (Statements). Joined to the invoice and
    // scoped like fetchSalesOrderItems: ids of another database's or a deleted
    // invoice just return no lines. ORDER BY pins line order (entry order), which
    // the join could otherwise change.
    static async fetchOrderItemsById(ids, database_id) {
        let query = `SELECT
            I.*,
            P.product_name
            FROM sales_order_items I
            INNER JOIN sales_orders O ON O.order_id = I.order_id
            INNER JOIN products P ON I.product_id = P.product_id
            WHERE I.is_deleted = 0
            AND O.is_deleted = 0 AND O.database_id = ?
            AND I.order_id IN (?)
            ORDER BY I.order_id, I.order_item_id`;
        let [results] = await pool.query(query, [database_id, ids]);
        return results;
    }

    // fetch sales invoices — headers only; the lines are fetched per invoice
    // (fetchSalesOrderItems) because aggregating them for every row made the list slow
    static async fetchSalesHistory(database_id, criteria) {
        let sql = `SELECT
                A.name AS customer_name,
                A.phone AS customer_phone,
                A.address AS customer_address,
                O.*,
                DATE(O.order_datetime) AS order_date,
                ${ACTOR_COLUMNS}
            FROM sales_orders O
            LEFT JOIN accounts  A ON O.customer_id = A.account_id
            ${actorJoins("O")}
            WHERE O.is_deleted = 0 AND O.database_id = ? `;
        const params = [database_id];
        if (criteria.invoice_number) {
            sql += ` AND O.invoice_number LIKE ?`;
            params.push(`%${criteria.invoice_number}%`);
        }
        if (criteria.customer_id) {
            sql += ` AND O.customer_id = ?`;
            params.push(criteria.customer_id);
        }
        if (criteria.start_date) {
            sql += ` AND DATE(order_datetime) >= ?`;
            params.push(moment(criteria.start_date).format("yyyy-MM-DD"));
        }
        if (criteria.end_date) {
            sql += ` AND DATE(order_datetime) <= ?`;
            params.push(moment(criteria.end_date).format("yyyy-MM-DD"));
        }

        sql += ` ORDER BY order_date DESC, O.invoice_number DESC`;

        const [rows] = await pool.query(sql, params);

        return rows;
    }

    // lines of one sales invoice, same shape the list used to embed (the edit
    // dialog round-trips them). null when the invoice is not this database's or
    // is deleted; [] when it has no lines.
    static async fetchSalesOrderItems(order_id, database_id) {
        const sql = `SELECT
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('order_item_id', M.order_item_id, 'product_id', M.product_id, 'product_name', S.product_name, 'sku', S.sku, 'quantity', M.quantity, 'price_type', M.price_type,'unit_cost', M.unit_cost, 'avg_cost', M.avg_cost, 'unit_price', M.unit_price, 'total_price', M.total_price))
                    FROM sales_order_items M
                    INNER JOIN products S ON S.product_id = M.product_id
                    WHERE M.order_id = O.order_id) items
            FROM sales_orders O
            WHERE O.order_id = ? AND O.is_deleted = 0 AND O.database_id = ?`;
        const [rows] = await pool.query(sql, [order_id, database_id]);
        if (!rows.length) return null;
        // mysql2 parses JSON columns; parse here too in case the scalar
        // subquery's type reaches the driver as text
        const { items } = rows[0];
        return (typeof items === "string" ? JSON.parse(items) : items) || [];
    }

    // A customer's latest sales lines of one product, newest first: the "recent
    // purchases" overlay of the sell / edit-invoice / return screens. Live invoices
    // and lines of the caller's database only; the caller has already checked that
    // the customer is this database's. Lines, not invoices: an invoice holding the
    // product twice gives two rows. order_item_id breaks ties so the order is stable.
    static async fetchRecentPurchases(product_id, customer_id, database_id) {
        const sql = `SELECT
                O.order_id,
                O.invoice_number,
                O.order_datetime,
                I.order_item_id,
                I.unit_price,
                I.quantity,
                I.total_price
            FROM sales_orders O
            INNER JOIN sales_order_items I ON I.order_id = O.order_id
            WHERE O.database_id = ?
            AND O.customer_id = ?
            AND O.is_deleted = 0
            AND I.product_id = ?
            AND I.is_deleted = 0
            ORDER BY O.order_datetime DESC, O.order_id DESC, I.order_item_id DESC
            LIMIT 5`;
        const [rows] = await pool.query(sql, [
            database_id,
            customer_id,
            product_id,
        ]);
        // mysql2 hands DECIMAL columns over as strings; the client formats numbers
        const num = (value) => (value === null ? null : Number(value));
        return rows.map((row) => ({
            ...row,
            unit_price: num(row.unit_price),
            quantity: num(row.quantity),
            total_price: num(row.total_price),
        }));
    }

    // fetch products sales history
    static async fetchProductsSalesHistory(database_id, criteria) {
        let sql = `SELECT soi.*, p.sku, p.product_name, a.name AS customer_name, so.invoice_number, so.order_datetime 
			FROM sales_order_items soi 
			INNER JOIN sales_orders so ON soi.order_id = so.order_id
			INNER JOIN products p ON soi.product_id = p.product_id
			LEFT JOIN accounts a ON so.customer_id = a.account_id

			WHERE soi.is_deleted = 0 
			AND so.database_id = ? `;
        const params = [database_id];
        if (criteria.customer_id) {
            sql += ` AND so.customer_id = ?`;
            params.push(criteria.customer_id);
        }
        if (criteria.product_id) {
            sql += ` AND soi.product_id = ?`;
            params.push(criteria.product_id);
        }
        if (criteria.invoice_number) {
            sql += ` AND so.invoice_number LIKE ?`;
            params.push(`%${criteria.invoice_number}`);
        }
        if (criteria.start_date) {
            sql += ` AND DATE(order_datetime) >= ?`;
            params.push(moment(criteria.start_date).format("yyyy-MM-DD"));
        }
        if (criteria.end_date) {
            sql += ` AND DATE(order_datetime) <= ?`;
            params.push(moment(criteria.end_date).format("yyyy-MM-DD"));
        }

        sql += ` ORDER BY order_datetime DESC`;
        params.push(criteria.limit || 1000);

        const [rows] = await pool.query(sql, params);
        return rows;
    }

    //fetch payment history
    static async fetchPaymentHistory(database_id, criteria) {
        let sql = `SELECT
				A.name AS partner_name,
				A.name AS customer_name,
				A.phone AS partner_phone,
				A.phone AS customer_phone,
				A.address AS partner_address,
				A.address AS customer_address,
				A.account_id AS account_id,
				A.account_id AS customer_id,
                A.account_id AS partner_id,
				P.*,
				P.total_value as amount,
				P.journal_date AS payment_date,
                P.journal_notes AS money_account
			FROM journal_vouchers P
			INNER JOIN journal_items I ON P.journal_id = I.journal_id_fk
			INNER JOIN accounts A ON I.partner_id_fk = A.account_id
			WHERE P.is_deleted = 0 AND P.database_id = ? AND journal_description = 'Payment Received'`;
        const params = [database_id];
        if (criteria.payment_number) {
            sql += ` AND P.journal_number LIKE ?`;
            params.push(`%${criteria.payment_number}`);
        }
        if (criteria.partner_id) {
            sql += ` AND I.partner_id_fk = ?`;
            params.push(criteria.partner_id);
        }
        if (criteria.start_date) {
            sql += ` AND DATE(P.journal_date) >= ?`;
            params.push(moment(criteria.start_date).format("yyyy-MM-DD"));
        }
        if (criteria.end_date) {
            sql += ` AND DATE(P.journal_date) <= ?`;
            params.push(moment(criteria.end_date).format("yyyy-MM-DD"));
        }

        sql += ` ORDER BY payment_date DESC, P.journal_number DESC
		LIMIT ? OFFSET ?`;
        params.push(criteria.limit || 100);
        params.push(criteria.offset || 0);

        const [rows] = await pool.query(sql, params);
        return rows;
    }

    //fetch return history — headers only; lines come from fetchReturnOrderItems
    static async fetchReturnHistory(database_id, criteria) {
        let sql = `SELECT
                A.name AS customer_name,
                A.phone AS customer_phone,
                A.address AS customer_address,
                RO.*,
                DATE(RO.order_datetime) AS order_date,
                ${ACTOR_COLUMNS}
            FROM return_orders RO
            INNER JOIN accounts  A ON RO.customer_id = A.account_id
            ${actorJoins("RO")}
            WHERE RO.is_deleted = 0 AND A.database_id = ? `;
        const params = [database_id];
        if (criteria.invoice_number) {
            sql += ` AND RO.invoice_number = ?`;
            params.push(criteria.invoice_number);
        }
        if (criteria.customer_id) {
            sql += ` AND RO.customer_id = ?`;
            params.push(criteria.customer_id);
        }
        if (criteria.start_date) {
            sql += ` AND DATE(order_datetime) >= ?`;
            params.push(moment(criteria.start_date).format("yyyy-MM-DD"));
        }
        if (criteria.end_date) {
            sql += ` AND DATE(order_datetime) <= ?`;
            params.push(moment(criteria.end_date).format("yyyy-MM-DD"));
        }

        sql += ` ORDER BY order_date DESC, RO.invoice_number DESC
        LIMIT ? OFFSET ?`;
        params.push(criteria.limit || 100);
        params.push(criteria.offset || 0);

        const [rows] = await pool.query(sql, params);
        return rows;
    }

    // lines of one return, same shape the list used to embed; scoped through
    // the customer's database like the list. null when not found / deleted.
    static async fetchReturnOrderItems(order_id, database_id) {
        const sql = `SELECT
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('order_item_id', M.order_item_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'price_type', M.price_type,'unit_cost', M.unit_cost, 'avg_cost', M.avg_cost, 'unit_price', M.unit_price, 'total_price', M.total_price))
                    FROM return_order_items M
                    INNER JOIN products S ON S.product_id = M.product_id
                    WHERE M.order_id = RO.order_id) items
            FROM return_orders RO
            INNER JOIN accounts  A ON RO.customer_id = A.account_id
            WHERE RO.order_id = ? AND RO.is_deleted = 0 AND A.database_id = ?`;
        const [rows] = await pool.query(sql, [order_id, database_id]);
        if (!rows.length) return null;
        const { items } = rows[0];
        return (typeof items === "string" ? JSON.parse(items) : items) || [];
    }

    // fetch return order items by order id (Statements). Scoped through the
    // customer's database like fetchReturnOrderItems: ids of another database's
    // or a deleted return just return no lines. ORDER BY as above.
    static async fetchReturnOrderItemsById(ids, database_id) {
        let query = `SELECT
            ROI.*,
            P.product_name
            FROM return_order_items ROI
            INNER JOIN return_orders RO ON RO.order_id = ROI.order_id
            INNER JOIN accounts A ON RO.customer_id = A.account_id
            INNER JOIN products P ON ROI.product_id = P.product_id
            WHERE ROI.is_deleted = 0
            AND RO.is_deleted = 0 AND A.database_id = ?
            AND ROI.order_id IN (?)
            ORDER BY ROI.order_id, ROI.order_item_id`;
        let [results] = await pool.query(query, [database_id, ids]);
        return results;
    }

    //fetch products dispose history
    static async fetchDisposeHistory(database_id, criteria) {
        let sql = `SELECT 
					DP.*,
					DATE(DP.dispose_datetime) AS dispose_date,
					JSON_ARRAYAGG(JSON_OBJECT('product_id', DI.product_id, 'product_name', S.product_name, 'quantity', DI.quantity, 'unit_cost', DI.unit_cost)) items
				FROM dispose_products DP
				INNER JOIN dispose_products_items DI ON DP.dispose_id = DI.dispose_id
				INNER JOIN products S ON S.product_id = DI.product_id
				WHERE DP.is_deleted = 0 AND DP.database_id = ?`;
        const params = [database_id];
        if (criteria.invoice_number) {
            sql += ` AND DP.invoice_number = ?`;
            params.push(criteria.invoice_number);
        }
        if (criteria.start_date) {
            sql += ` AND DATE(DP.dispose_datetime) >= ?`;
            params.push(moment(criteria.start_date).format("yyyy-MM-DD"));
        }
        if (criteria.end_date) {
            sql += ` AND DATE(DP.dispose_datetime) <= ?`;
            params.push(moment(criteria.end_date).format("yyyy-MM-DD"));
        }

        sql += ` GROUP BY DP.dispose_id 
		ORDER BY dispose_date DESC, DP.invoice_number DESC
			LIMIT ? OFFSET ?`;
        params.push(criteria.limit || 100);
        params.push(criteria.offset || 0);

        const [rows] = await pool.query(sql, params);
        return rows;
    }

    // fetch dispose items history
    static async fetchDisposeItemsHistory(database_id, criteria) {
        let sql = `SELECT dpi.*, p.sku, p.product_name, dp.invoice_number, dp.dispose_datetime
            FROM dispose_products_items dpi
            INNER JOIN dispose_products dp ON dpi.dispose_id = dp.dispose_id
            INNER JOIN products p ON dpi.product_id = p.product_id
            WHERE dp.is_deleted = 0
            AND dp.database_id = ?`;
        const params = [database_id];
        if (criteria.product_id) {
            sql += ` AND dpi.product_id = ?`;
            params.push(criteria.product_id);
        }
        if (criteria.invoice_number) {
            sql += ` AND dp.invoice_number LIKE ?`;
            params.push(`%${criteria.invoice_number}%`);
        }
        if (criteria.start_date) {
            sql += ` AND DATE(dp.dispose_datetime) >= ?`;
            params.push(moment(criteria.start_date).format("yyyy-MM-DD"));
        }
        if (criteria.end_date) {
            sql += ` AND DATE(dp.dispose_datetime) <= ?`;
            params.push(moment(criteria.end_date).format("yyyy-MM-DD"));
        }

        sql += ` ORDER BY dp.dispose_datetime DESC`;

        const [rows] = await pool.query(sql, params);
        return rows;
    }
}

module.exports = History;
