const pool = require("../config/database");
// const moment = require("moment");
const moment = require("moment-timezone");
const InventoryCosting = require("./InventoryCosting");
const { AppError } = require("../middleware/errorHandler");
const { actorId, stampActors } = require("./OrderActors");

// Migration (run manually):
// ALTER TABLE deliver_order_items ADD COLUMN avg_cost_usd DECIMAL(10,2) NULL AFTER unit_price;
// Holds the SENDER's weighted-average cost at the moment of dispatch. The receipt is
// costed from this rather than from the sender's live average, because approval happens
// later and the sender may have purchased more stock in between — the goods should be
// valued at what they cost when they left, not when the paperwork was signed.
// NULL on rows created before the column existed; approvePendingInvoice falls back to
// the sender's live average for those.

// Who a delivery may be addressed to: another tenant with a live 'user' login, and never
// the admin's tenant (users can't deliver to the admin). A staff-only or deleted tenant
// has nobody to approve it, so the sender would be debited for goods nobody receives.
// One predicate for every caller (the admin's own tenant drops out through `!= caller`),
// shared by the recipient list and the create/update check so the two cannot drift.
// Binds the sender's database_id. EXISTS rather than a join, so a tenant with several
// 'user' rows is listed once. An admin row counts even when deleted: it still marks the
// admin's tenant.
const RECIPIENT_WHERE = `d.database_id != ?
    AND EXISTS (SELECT 1 FROM users u WHERE u.database_id = d.database_id
        AND u.user_type = 'user' AND u.is_deleted = 0)
    AND NOT EXISTS (SELECT 1 FROM users a WHERE a.database_id = d.database_id
        AND a.user_type = 'admin')`;

// Same answer for the admin, the caller itself, an unknown, staff-only or deleted
// tenant and a malformed id. Not a 400: the edit dialog reads 400 as "already approved"
// and closes, while this one should stay open to pick another recipient.
const RECIPIENT_REFUSED = "You can't deliver to this user.";

// A positive integer from the body (an id, or a line's quantity), or null. Anything
// else is refused before it is bound: an object would expand into `key` = value SQL.
function toId(value) {
    const id =
        typeof value === "number" || typeof value === "string"
            ? Number(value)
            : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// What a delivery takes from the request body, and nothing else. The order row and
// every line used to be the body objects themselves, bound to `INSERT ... SET ?`, so a
// sender could write any column: is_approved = 1 (or is_deleted = 1) on the order
// debited them for goods the receiver was never asked to approve, is_deleted on a line
// hid it the same way, and order_id / record_id picked the primary key (one near the
// INT maximum stops every later insert, any tenant's). Rows are now built from the
// checked values below, and the rest of each row is the server's; unknown keys are
// left out. No body value is bound unchecked: mysql2 expands an object bound to `?`
// into `key` = value pairs, so {"is_deleted":0} would turn `WHERE order_id = ?` into a
// predicate matching every tenant's rows, and inside a SET would add assignments.
// Each check throws, so the transaction rolls back with nothing written.

// A DECIMAL from the body (total_price, unit_price): a finite number, or a plain
// decimal string, as mysql2 hands DECIMALs back (the edit dialog can send a total it
// never recomputed). Returned as sent, so a valid body binds what it always did.
function toAmount(value, field) {
    const valid =
        typeof value === "number"
            ? Number.isFinite(value)
            : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value);
    if (!valid) throw new Error(`Invalid ${field}`);
    return value;
}

// order_datetime as stored: the date the body picked, at the current Beirut time. A
// string moment can't read used to reach the SQL as "Invalid date" and fail there.
function toOrderDatetime(value) {
    moment.tz.setDefault("Asia/Beirut");
    const date = typeof value === "string" ? moment(value) : null;
    if (!date?.isValid()) throw new Error("Invalid order_datetime");
    return date.format(`YYYY-MM-DD ${moment().format("HH:mm:ss")}`);
}

// deliver_orders.notes is VARCHAR(255) utf8mb4: null, or a string of at most 255
// characters (code points, as MySQL counts them).
function toNotes(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || Array.from(value).length > 255) {
        throw new Error("Invalid notes");
    }
    return value;
}

// The checked values as a row for `SET ?`, in the order the body sent its keys, so a
// valid body binds exactly what it did when it was the row itself. A key the body
// didn't send stays out, and its column keeps its default, as before.
function inBodyOrder(body, checked) {
    return Object.fromEntries(
        Object.keys(body)
            .filter((key) => Object.prototype.hasOwnProperty.call(checked, key))
            .map((key) => [key, checked[key]]),
    );
}

// One deliver_order_items row from a body line: product_id, quantity and unit_price,
// plus the line's own record_id when `reusable` (update() only) still holds it, each
// at most once. Whole units, at least 1: the screens send no less, and a negative line
// would credit the sender with stock that approval then skips. The caller adds
// order_id_fk and avg_cost_usd.
function lineOf(record, reusable) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error("Invalid item");
    }
    const product_id = toId(record.product_id);
    if (!product_id) throw new Error("Invalid product_id");
    const quantity = toId(record.quantity);
    if (!quantity) throw new Error("Invalid quantity");
    const checked = {
        product_id,
        quantity,
        unit_price: toAmount(record.unit_price, "unit_price"),
    };
    const record_id = toId(record.record_id);
    if (record_id && reusable?.delete(record_id)) checked.record_id = record_id;
    return inBodyOrder(record, checked);
}

class DeliverInvoice {
    // GET /deliver/recipients, and the deprecated /deliver/users and /user-deliver/users
    static async getRecipients(database_id) {
        const [rows] = await pool.query(
            `SELECT d.database_id, d.database_name FROM user_database d
            WHERE ${RECIPIENT_WHERE}
            ORDER BY d.database_name`,
            [database_id],
        );
        return rows;
    }

    /**
     * Refuse a recipient the list above would not offer this sender (403, nothing
     * written: the transaction rolls back). The list only decides what the screens
     * offer; this is what stops an old build or a hand-made request from delivering
     * to the admin.
     *
     * Returns the checked id, which the caller writes to the row so it stores exactly
     * what was checked.
     *
     * A plain read, not a lock: a recipient whose user is deleted in the same instant
     * can still slip through. Accepted: locking would need FOR SHARE inside both
     * subqueries, holding users rows for the length of every create and update.
     */
    static async assertRecipient(connection, recipient, database_id) {
        const id = toId(recipient);
        if (id) {
            const [[row]] = await connection.query(
                `SELECT d.database_id FROM user_database d
                WHERE d.database_id = ? AND ${RECIPIENT_WHERE}`,
                [id, database_id],
            );
            if (row) return id;
        }
        throw new AppError(RECIPIENT_REFUSED, 403);
    }

    /**
     * GET /deliver/recipients/:database_id/stock — what the recipient already holds, for
     * the deliver screen's "their qty" column. [{ product_id, quantity }] only: the
     * screen has no business with another tenant's prices or costs.
     *
     * The id must pass assertRecipient, the same check as delivering to it, so even an
     * admin can only read tenants it could deliver to (never its own tenant or another
     * admin's). A malformed id is refused there before any query runs.
     *
     * Rows and quantity mirror the recipient's own stock list (UserStockModel.getAll):
     * one row per product they have a live inventory row for, deleted products left out,
     * 0 when the row has no transactions. A product missing from the result is therefore
     * one they don't stock, as opposed to one they stock at 0. I.is_deleted = 0 drops
     * nothing that list shows (deleting a product flags its inventory rows with it), but
     * approvePendingInvoice treats a deleted row as absent and opens a new one, so it
     * keeps such a product from appearing twice. Two live rows for one product (e.g.
     * two first receipts racing) still come back twice, with the same quantity, as in
     * that list: consumers key the result by product_id.
     */
    static async getRecipientStock(recipient, database_id) {
        const id = await DeliverInvoice.assertRecipient(
            pool,
            recipient,
            database_id,
        );
        const [rows] = await pool.query(
            `SELECT P.product_id, COALESCE(t.quantity, 0) AS quantity
            FROM products P
            INNER JOIN inventory I ON P.product_id = I.product_id_fk AND I.database_id = ?
            LEFT JOIN (
                SELECT
                    product_id_fk,
                    SUM(CASE WHEN transaction_type = 'ADD' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'REMOVE' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'DELETE' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'SUPPLY' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'RETURN' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'SALE' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'DISPOSE' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'DELIVER' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'REVERSERETURN' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'REVERSEDISPOSE' THEN quantity ELSE 0 END) +
                    SUM(CASE WHEN transaction_type = 'REVERSEDELIVER' THEN quantity ELSE 0 END) AS quantity
                FROM inventory_transactions
                WHERE database_id = ?
                AND is_deleted = 0
                GROUP BY product_id_fk
            ) t ON P.product_id = t.product_id_fk
            WHERE P.is_deleted = 0 AND I.is_deleted = 0
            ORDER BY P.product_id ASC`,
            [id, id],
        );
        // mysql2 hands back the SUM (a DECIMAL) as a string
        return rows.map((r) => ({
            product_id: r.product_id,
            quantity: Number(r.quantity),
        }));
    }

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

            // read field by field, never bound as they are (see toId and below)
            if (!order || typeof order !== "object" || Array.isArray(order)) {
                throw new Error("Invalid order");
            }
            if (!Array.isArray(items)) throw new Error("Invalid items");
            const order_datetime = toOrderDatetime(order.order_datetime);
            const total_price = toAmount(order.total_price, "total_price");
            const notes = toNotes(order.notes);

            // before anything is written: users can't deliver to the admin. Written
            // back to the body too, for the controller's deliverAdded event.
            order.database_id = await DeliverInvoice.assertRecipient(
                connection,
                order.database_id,
                user.database_id,
            );

            // These four from the body, the rest the server's: the sender is the
            // caller, invoice_number is set below, is_approved / approved_at /
            // is_deleted keep their defaults (pending, live).
            const row = inBodyOrder(order, {
                database_id: order.database_id,
                order_datetime,
                total_price,
                notes,
            });
            row.admin_id_fk = user.database_id;
            // prepared by the caller (token), never a body value
            stampActors(row, actorId(user), null);

            // insert into deliver_orders
            const [result] = await connection.query(
                `INSERT INTO deliver_orders SET ?`,
                [row],
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
                const line = lineOf(record);

                // Snapshot the sender's cost as the goods leave, and refuse the dispatch
                // outright if there is no cost to snapshot. Pinning it here means the
                // receiver is charged what the goods cost at dispatch rather than
                // whatever the sender's average happens to be whenever the delivery is
                // finally approved.
                const senderCost = await DeliverInvoice.assertSenderCost(
                    connection,
                    user.database_id,
                    line.product_id,
                    record.product_name,
                );

                // insert into order items
                await connection.query(
                    `INSERT INTO deliver_order_items SET ?`,
                    {
                        ...line,
                        order_id_fk: order_id,
                        avg_cost_usd: senderCost,
                    },
                );

                // add record to inventory transactions
                // parameterized: values were interpolated into SQL with multipleStatements on
                // (the line's values come from the request body, checked by lineOf)
                await connection.query(
                    `INSERT INTO inventory_transactions (product_id_fk, database_id, quantity, transaction_type, transaction_notes, order_id_fk) VALUES (?, ?, ?, 'DELIVER', ?, ?);`,
                    [
                        line.product_id,
                        user.database_id,
                        -line.quantity,
                        invoice_number,
                        order_id,
                    ],
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

            // read field by field, as in create(); the UPDATE below names its columns,
            // so is_approved, approved_at, admin_id_fk and created_by_user_id are never
            // the body's to change, and invoice_number is read from the stored row
            if (!order || typeof order !== "object" || Array.isArray(order)) {
                throw new Error("Invalid order");
            }
            if (!Array.isArray(items)) throw new Error("Invalid items");
            // a malformed id gets the same answer as an unknown one
            const order_id = toId(order.order_id);
            if (!order_id) throw new Error("approved");
            const order_datetime = toOrderDatetime(order.order_datetime);
            const total_price = toAmount(order.total_price, "total_price");
            const notes = toNotes(order.notes);

            // only the caller's own (admin_id_fk, as in delete()), live, pending order:
            // looked up by order_id alone, any login of any tenant (staff included) could
            // rewrite another tenant's pending delivery. Another tenant's, a deleted or an
            // unknown order all get the same "approved" answer; the edit dialog only
            // opens the caller's own live sends
            let [[checkPending]] = await connection.query(
                `SELECT * FROM deliver_orders WHERE order_id = ? AND is_approved = 0 AND is_deleted = 0 AND admin_id_fk = ?`,
                [order_id, user.database_id],
            );
            if (!checkPending) throw new Error("approved");

            // an edit can re-point the delivery, so the create rule applies here too,
            // against the order's stored sender (the caller's tenant, per the lookup
            // above): the row must never point back at it
            const database_id = await DeliverInvoice.assertRecipient(
                connection,
                order.database_id,
                checkPending.admin_id_fk,
            );

            // insert into deliver_orders
            // the editor is the caller (token); created_by_user_id is never touched here
            const [result] = await connection.query(
                `UPDATE deliver_orders SET order_datetime = ?, total_price = ?, database_id = ?, notes = ?, updated_by_user_id = ? WHERE order_id = ?`,
                [
                    order_datetime,
                    total_price,
                    database_id,
                    notes,
                    actorId(user),
                    order_id,
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
                `SELECT record_id, product_id, quantity, avg_cost_usd
				FROM deliver_order_items WHERE order_id_fk = ? AND is_deleted = 0`,
                [order_id],
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
            // the edit dialog sends each line it loaded back with its record_id, and
            // the line is re-inserted under it; any other id is dropped (see lineOf)
            const reusable = new Set(oldLines.map((l) => l.record_id));

            await connection.query(
                `DELETE FROM inventory_transactions WHERE transaction_type = 'DELIVER' AND order_id_fk = ? AND database_id = ?`,
                [order_id, user.database_id],
            );

            //delete invoice items
            await connection.query(
                `DELETE FROM deliver_order_items WHERE order_id_fk = ?`,
                [order_id],
            );

            //	********************************
            //	loop of each invoice item record
            //	********************************

            for (const record of items) {
                const line = lineOf(record, reusable);

                // re-snapshot on edit — the line may now be a different product or
                // quantity, and the order is still pending so nothing has been received
                const senderCost = await DeliverInvoice.assertSenderCost(
                    connection,
                    user.database_id,
                    line.product_id,
                    record.product_name,
                );

                // insert into order items
                await connection.query(
                    `INSERT INTO deliver_order_items SET ?`,
                    {
                        ...line,
                        avg_cost_usd: senderCost,
                        order_id_fk: order_id,
                    },
                );

                // add admin record to inventory transactions
                // parameterized: values were interpolated into SQL with multipleStatements on
                // (the line's values come from the body, checked by lineOf; the invoice
                // number is the stored one, never the body's)
                await connection.query(
                    `INSERT INTO inventory_transactions (product_id_fk, database_id, quantity, transaction_type, transaction_notes, order_id_fk) VALUES (?, ?, ?, 'DELIVER', ?, ?);`,
                    [
                        line.product_id,
                        user.database_id,
                        -line.quantity,
                        checkPending.invoice_number,
                        order_id,
                    ],
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
