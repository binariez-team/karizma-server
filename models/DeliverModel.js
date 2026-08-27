const pool = require("../config/database");
// const moment = require("moment");
const moment = require("moment-timezone");
const InventoryCosting = require("./InventoryCosting");

// Migration (run manually):
// ALTER TABLE deliver_order_items ADD COLUMN avg_cost_usd DECIMAL(10,2) NULL AFTER unit_price;
// Holds the SENDER's weighted-average cost at the moment of dispatch. The receipt is
// costed from this rather than from the sender's live average, because approval happens
// later and the sender may have purchased more stock in between — the goods should be
// valued at what they cost when they left, not when the paperwork was signed.
// NULL on rows created before the column existed; approvePendingInvoice falls back to
// the sender's live average for those.

class DeliverInvoice {
    /**
     * The sender's cost basis for a product at this instant. Falls back to their last
     * known unit cost, then to null — the caller decides what to do with an unpriced
     * line, since a zero would seed a zero-cost pool on the receiving side.
     */
    static async senderCostFor(connection, database_id, product_id) {
        const [[row]] = await connection.query(
            `SELECT avg_cost_usd, unit_cost_usd FROM inventory
			WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
            [product_id, database_id],
        );
        const avg = Number(row?.avg_cost_usd) || 0;
        const unit = Number(row?.unit_cost_usd) || 0;
        return avg > 0 ? avg : unit > 0 ? unit : null;
    }

    /**
     * Refuse to dispatch a product the sender holds no cost for.
     *
     * A transfer is valued at the sender's cost, so an unpriced product cannot be
     * shipped without inventing value: the receiver would book units the sender never
     * booked out. Falling back to the delivery note price would paper over it and make
     * the transfer non-neutral again, which is the whole thing this costing model is
     * meant to prevent.
     *
     * Narrow in practice — an unpriced product is one that entered stock without a
     * purchase (a manual correction, or a product created with no cost) — so the fix
     * is to give it a cost, not to relax this.
     */
    static async assertSenderCost(connection, database_id, product_id, name) {
        const cost = await DeliverInvoice.senderCostFor(
            connection,
            database_id,
            product_id,
        );
        if (cost === null) {
            throw new Error(
                `"${name || `Product ${product_id}`}" has no cost recorded in your stock, so it cannot be delivered. Set its cost first.`,
            );
        }
        return cost;
    }

    static async create(order, items, user) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            order.order_datetime = moment(order.order_datetime).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );
            order.admin_id_fk = user.database_id;

            // insert into deliver_orders
            const [result] = await connection.query(
                `INSERT INTO deliver_orders SET ?`,
                order,
            );

            // inserted order ID
            let order_id = result.insertId;

            // generate invoice_number
            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number, 4) AS UNSIGNED)), 1000) + 1 AS number FROM deliver_orders`,
            );
            let invoice_number = `DEL${number.toString().padStart(4, "0")}`;
            await connection.query(
                `UPDATE deliver_orders SET invoice_number = ? WHERE order_id = ?`,
                [invoice_number, order_id],
            );

            //	********************************
            //	loop of each invoice item record
            //	********************************

            for (const record of items) {
                const productName = record.product_name;
                delete record.product_name;
                delete record.stock;

                // Snapshot the sender's cost as the goods leave, and refuse the dispatch
                // outright if there is no cost to snapshot. Pinning it here means the
                // receiver is charged what the goods cost at dispatch rather than
                // whatever the sender's average happens to be whenever the delivery is
                // finally approved.
                const senderCost = await DeliverInvoice.assertSenderCost(
                    connection,
                    order.admin_id_fk,
                    record.product_id,
                    productName,
                );

                // insert into order items
                await connection.query(
                    `INSERT INTO deliver_order_items SET ?`,
                    {
                        ...record,
                        order_id_fk: order_id,
                        avg_cost_usd: senderCost,
                    },
                );

                // add record to inventory transactions
                await connection.query(
                    `INSERT INTO inventory_transactions (product_id_fk, database_id, quantity, transaction_type, transaction_notes, order_id_fk) VALUES (${
                        record.product_id
                    }, ${
                        order.admin_id_fk
                    }, ${-record.quantity}, 'DELIVER', '${invoice_number}', ${order_id});`,
                );

                // Dispatch deliberately does NOT touch the sender's costs.
                //
                // A delivery is an OUTFLOW for the sender. Under weighted-average costing
                // an outflow never moves the average — (V - q*avg)/(Q - q) = avg — and the
                // sender's value falls automatically, because stock value is derived as
                // SUM(inventory_transactions.quantity) * avg_cost_usd and the negative row
                // above already reduced the quantity.
                //
                // This used to run `UPDATE inventory SET unit_cost_usd = ?, avg_cost_usd = ?`
                // with the delivery note price, gated on a hardcoded `admin_id_fk == 1`, so
                // it fired on 434 of 1,969 deliveries and skipped the 1,535 user-to-user
                // ones. It repriced the units that STAYED, not the ones that shipped:
                // holding 500 @ 10.00 and delivering 10 @ 12.00 left the remaining 490
                // carried at 12.00, so the sender's inventory value ROSE while goods left
                // the building. Nothing reversed it on update or delete either.
                //
                // It also cannot stay now that the receipt side is costed from the sender's
                // average (UserHistoryModel.approvePendingInvoice): overwriting that average
                // at dispatch would feed the note price straight into the receiver's pool,
                // defeating the point of transferring at cost.
                //
                // unit_cost_usd is left alone for the same reason — it means "the last cost
                // we were told about", and shipping goods out tells us nothing new about
                // what they cost. It also seeds PurchaseModel's reseed branch and the
                // deliver screen's default transfer price, both of which want a real cost.
            }

            // after successfull
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // update deliver
    static async update(order, items, user) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            order.order_datetime = moment(order.order_datetime).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );
            order.admin_id_fk = user.database_id;

            let [[checkPending]] = await connection.query(
                `SELECT * FROM deliver_orders WHERE order_id = ? AND is_approved = 0`,
                [order.order_id],
            );
            if (!checkPending) throw new Error("approved");

            // insert into deliver_orders
            const [result] = await connection.query(
                `UPDATE deliver_orders SET order_datetime = ?, total_price = ?, database_id = ?, notes = ? WHERE order_id = ?`,
                [
                    order.order_datetime,
                    order.total_price,
                    order.database_id,
                    order.notes,
                    order.order_id,
                ],
            );

            // Undoing a dispatch returns the units to the sender, so their value has to
            // come back at the cost they LEFT at — the snapshot taken when the delivery
            // was raised. Deleting the negative DELIVER rows below returns the quantity
            // but not the value, which would hand the sender back q units priced at
            // today's average instead of what they were relieved at.
            //
            // Read before the ledger delete, so the blend sees on-hand WITHOUT the
            // returning units, and before deliver_order_items is cleared below, which
            // destroys the snapshots this depends on. Legacy rows have a NULL snapshot
            // and are skipped by applyValue — for those the quantity still returns and
            // the value still moves at today's average, exactly as it did before.
            const [oldLines] = await connection.query(
                `SELECT product_id, quantity, avg_cost_usd
				FROM deliver_order_items WHERE order_id_fk = ? AND is_deleted = 0`,
                [order.order_id],
            );
            await InventoryCosting.applyValue(
                connection,
                user.database_id,
                oldLines.map((l) => ({
                    product_id: l.product_id,
                    quantity: l.quantity,
                    cost: l.avg_cost_usd,
                })),
                1,
            );

            await connection.query(
                `DELETE FROM inventory_transactions WHERE transaction_type = 'DELIVER' AND order_id_fk = ? AND database_id = ?`,
                [order.order_id, user.database_id],
            );

            //delete invoice items
            await connection.query(
                `DELETE FROM deliver_order_items WHERE order_id_fk = ?`,
                [order.order_id],
            );

            //	********************************
            //	loop of each invoice item record
            //	********************************

            for (const record of items) {
                const productName = record.product_name;
                delete record.product_name;
                delete record.stock;

                // re-snapshot on edit — the line may now be a different product or
                // quantity, and the order is still pending so nothing has been received
                const senderCost = await DeliverInvoice.assertSenderCost(
                    connection,
                    order.admin_id_fk,
                    record.product_id,
                    productName,
                );

                // insert into order items
                await connection.query(
                    `INSERT INTO deliver_order_items SET ?`,
                    {
                        ...record,
                        avg_cost_usd: senderCost,
                        order_id_fk: order.order_id,
                    },
                );

                // add admin record to inventory transactions
                await connection.query(
                    `INSERT INTO inventory_transactions (product_id_fk, database_id, quantity, transaction_type, transaction_notes, order_id_fk) VALUES (${
                        record.product_id
                    }, ${order.admin_id_fk}, ${-record.quantity}, 'DELIVER', '${
                        order.invoice_number
                    }', ${order.order_id});`,
                );
            }

            // after successfull
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    static async delete(order_id, database_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            let [[checkPending]] = await connection.query(
                `SELECT * FROM deliver_orders WHERE order_id = ? AND is_approved = 0 AND admin_id_fk = ?`,
                [order_id, database_id],
            );
            if (!checkPending) throw new Error("approved");

            // Return the dispatched value to the sender at the cost it left at, before
            // the ledger delete below returns the quantity. See the same block in
            // update() for why this cannot run after either statement.
            const [oldLines] = await connection.query(
                `SELECT product_id, quantity, avg_cost_usd
				FROM deliver_order_items WHERE order_id_fk = ? AND is_deleted = 0`,
                [order_id],
            );
            await InventoryCosting.applyValue(
                connection,
                database_id,
                oldLines.map((l) => ({
                    product_id: l.product_id,
                    quantity: l.quantity,
                    cost: l.avg_cost_usd,
                })),
                1,
            );

            await connection.query(
                `DELETE FROM inventory_transactions WHERE transaction_type = 'DELIVER' AND order_id_fk = ? AND database_id = ?`,
                [order_id, database_id],
            );

            //delete invoice items
            await connection.query(
                `UPDATE deliver_order_items SET is_deleted = 1 WHERE order_id_fk = ?`,
                [order_id],
            );

            //delete invoice
            await connection.query(
                `UPDATE deliver_orders SET is_deleted = 1 WHERE order_id = ?`,
                [order_id],
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

module.exports = DeliverInvoice;
