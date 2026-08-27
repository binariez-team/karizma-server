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

    // `database_id` is the RECEIVING tenant and must come from the caller's token.
    // The sending tenant (`admin_id`) is read off the order, never accepted from the
    // caller — it selects whose inventory the opening cost basis is copied from.
    static async approvePendingInvoice(id, database_id) {
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            // 1. Load the order and prove it is addressed to this tenant.
            // FOR UPDATE serialises concurrent approvals: the is_approved guard below
            // is only meaningful if two callers cannot both read the row as pending and
            // then both post the receipt.
            const [[check]] = await connection.query(
                `SELECT is_approved, is_deleted, database_id, admin_id_fk
                FROM deliver_orders WHERE order_id = ? FOR UPDATE`,
                [id],
            );

            // Same response for "does not exist" and "belongs to someone else", so the
            // endpoint cannot be used to probe for other tenants' order ids.
            if (!check || Number(check.database_id) !== Number(database_id)) {
                await connection.rollback();
                return { status: "error", message: "Order not found" };
            }

            const admin_id = check.admin_id_fk;

            // Compare truthily, not against 1: config/database.js casts every
            // TINYINT(1) to a JS boolean, so `is_approved === 1` is always false and
            // this guard never fired — approval was re-runnable and re-posted the
            // receipt (and its weighted-average cost merge) on every call.
            if (check.is_approved) {
                await connection.rollback();
                return { status: "error", message: "Already approved!" };
            }

            // 1.1 Check if the order is deleted
            // same TINYINT(1) -> boolean cast applies here
            if (check.is_deleted) {
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
                `SELECT product_id, quantity, unit_price, avg_cost_usd
                FROM deliver_order_items
                WHERE order_id_fk = ? AND is_deleted = 0`,
                [id],
            );

            for (const record of items) {
                const incomingQty = Number(record.quantity);

                if (!(incomingQty > 0)) continue;

                // 4. The sender's cost basis for this product.
                // A transfer moves goods at the SENDER's cost, not at the price on the
                // delivery note. That price is a reference/selling figure and may carry a
                // margin; costing the receipt at it would book in more (or less) value
                // than the sender relieved, and since deliveries write no journal entries
                // there is nothing anywhere to absorb the difference. Using the sender's
                // cost keeps a transfer value-neutral for the group, and it makes a
                // delivery from user A at their cost of 10 blend into the receiver's pool
                // distinctly from user C's at 12 — which is the point of the model.
                //
                // Prefer the cost SNAPSHOTTED at dispatch (DeliverModel.senderCostFor):
                // approval can happen days later, and by then the sender may have bought
                // more stock at a different price. The goods should be valued at what they
                // cost when they left, not when the paperwork was signed.
                const snapshotCost = Number(record.avg_cost_usd) || 0;

                // Rows created before deliver_order_items.avg_cost_usd existed have no
                // snapshot, so fall back to the sender's live average for those.
                const [[senderInventory]] = await connection.query(
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

                // mysql2 returns DECIMAL as a string, so '0.00' is truthy — `??` would
                // let a zero-cost sender seed a zero-cost pool, which then reports 100%
                // margin on every sale until something dilutes it. Fall back through the
                // sender's last known cost to the delivery price rather than accept 0.
                const senderAvg = Number(senderInventory?.avg_cost_usd) || 0;
                const senderUnitCost =
                    Number(senderInventory?.unit_cost_usd) || 0;
                const incomingUnitCost =
                    snapshotCost > 0
                        ? snapshotCost
                        : senderAvg > 0
                          ? senderAvg
                          : senderUnitCost > 0
                            ? senderUnitCost
                            : Number(record.unit_price) || 0;

                // 5. Lock the receiver's row for the whole read-modify-write, so a
                // concurrent receipt of the same product cannot discard this blend.
                const [[inventory]] = await connection.query(
                    `SELECT avg_cost_usd
                 FROM inventory
                 WHERE product_id_fk = ?
                   AND database_id = ?
                   AND is_deleted = 0
                 FOR UPDATE`,
                    [record.product_id, database_id],
                );

                // 5.1 Create inventory if missing — first receipt opens the pool at the
                // sender's cost. Selling prices are seeded from the sender too; the user
                // can change them afterwards.
                if (!inventory) {
                    await connection.query(`INSERT INTO inventory SET ?`, {
                        product_id_fk: record.product_id,
                        database_id,
                        unit_cost_usd: incomingUnitCost,
                        avg_cost_usd: incomingUnitCost,
                        grandwhole_price_usd:
                            senderInventory?.grandwhole_price_usd ?? 0,
                        whole_price_usd: senderInventory?.whole_price_usd ?? 0,
                        unit_price_usd: senderInventory?.unit_price_usd ?? 0,
                    });
                } else {
                    // 6. Get current quantity BEFORE the DELIVER row is inserted below,
                    // or the incoming units would be counted on both sides of the blend.
                    const [[qtyRow]] = await connection.query(
                        `SELECT COALESCE(SUM(quantity), 0) AS quantity
                     FROM inventory_transactions
                     WHERE product_id_fk = ?
                       AND database_id = ?
                       AND is_deleted = 0`,
                        [record.product_id, database_id],
                    );

                    const currentQty = Math.max(Number(qtyRow.quantity), 0);
                    const currentAvgCost = Number(inventory.avg_cost_usd) || 0;

                    // 7. Blend. No special case is needed for an empty pool: with
                    // currentQty = 0 this reduces to exactly incomingUnitCost, and
                    // incomingQty is guaranteed > 0 above, so the divisor is never 0.
                    // An empty pool therefore reopens at the sender's cost, identical to
                    // the first-receipt branch above.
                    const newAvgCost =
                        (currentQty * currentAvgCost +
                            incomingQty * incomingUnitCost) /
                        (currentQty + incomingQty);

                    // Round to the stored scale before persisting — avg_cost_usd is
                    // DECIMAL(10,2), and the guard should see the value that lands.
                    const rounded = Math.round(newAvgCost * 100) / 100;
                    if (
                        !Number.isFinite(rounded) ||
                        rounded < 0 ||
                        rounded > 99999999.99
                    )
                        continue;

                    // 8. Update inventory avg cost
                    await connection.query(
                        `UPDATE inventory
                     SET avg_cost_usd = ?,
                     unit_cost_usd = ?
                     WHERE product_id_fk = ?
                       AND database_id = ?`,
                        [
                            rounded,
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
