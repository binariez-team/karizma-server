const pool = require("../config/database");
const moment = require("moment");

class UserHistory {
    // fetch deliver invoices sent
    static async fetchDeliverHistory(database_id, criteria) {
        let sql = `SELECT
                O.*,
                U.database_name AS first_name,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('record_id', M.record_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_price', M.unit_price)) items
            	FROM deliver_orders O
            	INNER JOIN deliver_order_items M ON O.order_id = M.order_id_fk
				INNER JOIN products S ON S.product_id = M.product_id
                INNER JOIN user_database U ON O.database_id = U.database_id
				WHERE O.is_deleted = 0
				AND O.admin_id_fk = ? `;
        const params = [database_id];
        if (criteria.invoice_number) {
            sql += ` AND O.invoice_number = ?`;
            params.push(criteria.invoice_number);
        }
        if (criteria.order_date) {
            sql += ` AND DATE(order_datetime) = ?`;
            params.push(moment(criteria.order_date).format("yyyy-MM-DD"));
        }

        sql += ` GROUP BY O.order_id
        ORDER BY order_date DESC, O.invoice_number DESC
        LIMIT ? OFFSET ?`;
        params.push(criteria.limit || 100);
        params.push(criteria.offset || 0);

        const [rows] = await pool.query(sql, params);
        return rows;
    }

    // fetch received deliveries
    static async fetchReceivedDeliveries(database_id, criteria) {
        let sql = `SELECT
                O.*,
                U.database_name AS first_name,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('record_id', M.record_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_price', M.unit_price)) items
            	FROM deliver_orders O
            	INNER JOIN deliver_order_items M ON O.order_id = M.order_id_fk
				INNER JOIN products S ON S.product_id = M.product_id
                INNER JOIN user_database U ON O.admin_id_fk = U.database_id
				WHERE O.is_deleted = 0
                AND O.is_approved = 1
				AND O.database_id = ? `;
        const params = [database_id];
        if (criteria.invoice_number) {
            sql += ` AND O.invoice_number = ?`;
            params.push(criteria.invoice_number);
        }
        if (criteria.order_date) {
            sql += ` AND DATE(order_datetime) = ?`;
            params.push(moment(criteria.order_date).format("yyyy-MM-DD"));
        }

        sql += ` GROUP BY O.order_id
        ORDER BY order_date DESC, O.invoice_number DESC
        LIMIT ? OFFSET ?`;
        params.push(criteria.limit || 100);
        params.push(criteria.offset || 0);

        const [rows] = await pool.query(sql, params);
        return rows;
    }

    // fetch pending
    static async fetchPendingInvoices(database_id) {
        let sql = `SELECT
                O.*,
                U.database_name AS first_name,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('record_id', M.record_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_price', M.unit_price)) items
            	FROM deliver_orders O
            	INNER JOIN deliver_order_items M ON O.order_id = M.order_id_fk
				INNER JOIN products S ON S.product_id = M.product_id
				INNER JOIN user_database U ON O.admin_id_fk = U.database_id
				WHERE O.is_deleted = 0
				AND O.is_approved = 0
				AND O.database_id = ? 
				GROUP BY O.order_id
				ORDER BY order_date DESC, O.invoice_number DESC`;

        const [rows] = await pool.query(sql, [database_id]);
        return rows;
    }

    static async approvePendingInvoice(id, database_id, admin_id) {
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            // 1. Check if already approved
            const [[check]] = await connection.query(
                `SELECT is_approved FROM deliver_orders WHERE order_id = ?`,
                [id],
            );

            if (check?.is_approved === 1) {
                await connection.rollback();
                return { status: "error", message: "Already approved!" };
            }

            // 1.1 Check if the order is deleted
            const [[checkDeleted]] = await connection.query(
                `SELECT is_deleted FROM deliver_orders WHERE order_id = ?`,
                [id],
            );
            if (checkDeleted?.is_deleted === 1) {
                await connection.rollback();
                return { status: "error", message: "Order is deleted!" };
            }

            // 2. Approve order
            await connection.query(
                `UPDATE deliver_orders SET is_approved = 1 WHERE order_id = ?`,
                [id],
            );

            // 3. Fetch invoice items
            const [items] = await connection.query(
                `SELECT product_id, quantity, unit_price
                FROM deliver_order_items
                WHERE order_id_fk = ? AND is_deleted = 0`,
                [id],
            );

            for (const record of items) {
                const incomingQty = record.quantity;
                const incomingUnitCost = record.unit_price;

                if (incomingQty <= 0) continue;

                // 4. Check inventory existence
                const [[inventory]] = await connection.query(
                    `SELECT avg_cost_usd
                 FROM inventory
                 WHERE product_id_fk = ?
                   AND database_id = ?
                   AND is_deleted = 0`,
                    [record.product_id, database_id],
                );

                // 5. Create inventory if missing (copy from admin)
                if (!inventory) {
                    const [[adminInventory]] = await connection.query(
                        `SELECT unit_cost_usd,
                            avg_cost_usd,
                            grandwhole_price_usd,
                            whole_price_usd,
                            unit_price_usd
                     FROM inventory
                     WHERE database_id = ?
                       AND product_id_fk = ?
                       AND is_deleted = 0`,
                        [admin_id, record.product_id],
                    );

                    await connection.query(`INSERT INTO inventory SET ?`, {
                        product_id_fk: record.product_id,
                        database_id,
                        unit_cost_usd:
                            adminInventory?.unit_cost_usd ?? incomingUnitCost,
                        avg_cost_usd:
                            adminInventory?.avg_cost_usd ?? incomingUnitCost,
                        grandwhole_price_usd:
                            adminInventory?.grandwhole_price_usd ?? 0,
                        whole_price_usd: adminInventory?.whole_price_usd ?? 0,
                        unit_price_usd: adminInventory?.unit_price_usd ?? 0,
                    });
                } else {
                    // 6. Get current quantity BEFORE insert
                    const [[qtyRow]] = await connection.query(
                        `SELECT COALESCE(SUM(quantity), 0) AS quantity
                     FROM inventory_transactions
                     WHERE product_id_fk = ?
                       AND database_id = ?
                       AND is_deleted = 0`,
                        [record.product_id, database_id],
                    );

                    const currentQty = Math.max(qtyRow.quantity, 0);

                    // 7. Fetch current avg cost
                    const [[costRow]] = await connection.query(
                        `SELECT avg_cost_usd
                     FROM inventory
                     WHERE product_id_fk = ?
                       AND database_id = ?
                       AND is_deleted = 0`,
                        [record.product_id, database_id],
                    );

                    const currentAvgCost = costRow?.avg_cost_usd ?? 0;

                    // 8. Calculate NEW moving average cost
                    let newAvgCost;

                    if (currentQty === 0) {
                        newAvgCost = incomingUnitCost;
                    } else {
                        newAvgCost =
                            (currentQty * currentAvgCost +
                                incomingQty * incomingUnitCost) /
                            (currentQty + incomingQty);
                    }
                    // 9. Update inventory avg cost
                    await connection.query(
                        `UPDATE inventory
                     SET avg_cost_usd = ?,
                     unit_cost_usd = ?
                     WHERE product_id_fk = ?
                       AND database_id = ?`,
                        [
                            newAvgCost,
                            incomingUnitCost,
                            record.product_id,
                            database_id,
                        ],
                    );
                }

                // 10. Insert inventory transaction
                await connection.query(
                    `INSERT INTO inventory_transactions
                 (product_id_fk, database_id, quantity, transaction_type, order_id_fk)
                 VALUES (?, ?, ?, 'DELIVER', ?)`,
                    [record.product_id, database_id, incomingQty, id],
                );
            }

            await connection.commit();

            return {
                status: "success",
                message: "Invoice approved successfully!",
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    //fetch transfer history
    static async fetchUserMoneyTransferHistory(database_id, criteria) {
        let sql = ` SELECT
        jv.journal_id,
        jv.journal_number,
        jv.journal_date as payment_date,
        jv.total_value
        FROM journal_vouchers jv
        WHERE jv.database_id = ? AND jv.journal_description = 'Transfer'
        AND jv.is_deleted = 0`;
        const params = [database_id];
        if (criteria.payment_number) {
            sql += ` AND jv.journal_number = ?`;
            params.push(criteria.payment_number);
        }
        if (criteria.payment_date) {
            sql += ` AND DATE(jv.journal_date) = ?`;
            params.push(moment(criteria.payment_date).format("yyyy-MM-DD"));
        }
        sql += ` ORDER BY payment_date DESC, jv.journal_number DESC`;

        const [transfers] = await pool.query(sql, params);
        return transfers;
    }
}

module.exports = UserHistory;
