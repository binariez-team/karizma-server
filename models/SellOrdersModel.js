const pool = require("../config/database");
const Accounts = require("./AccountsModel");
const Customer = require("./CustomersModel");
const moment = require("moment-timezone");

class SellOrders {
    // add order
    static async addOrder(order, items, database_id, payment) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            order.order_datetime = moment(order.order_datetime).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );

            // ##############################################################################################
            // ####################### create journal voucher and journal items #############################
            let query = `INSERT INTO journal_vouchers (database_id, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                order.order_datetime,
                "Invoice",
                order.total_amount,
            ]);

            // attach journal voucher id into order object
            order.journal_voucher_id = journal_voucher.insertId;

            // create first common journal item entry for sales
            // sales goods account
            const [salesGoodAccount] =
                await Accounts.getIdByAccountNumber("7011");
            const salesGood = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: order.order_datetime,
                account_id_fk: salesGoodAccount.id,
                credit: order.total_amount,
                database_id: database_id,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                salesGood,
            );

            if (order.customer_id) {
                const [receivablesAccount] =
                    await Accounts.getIdByAccountNumber("4111");

                const firstItem = {
                    journal_id_fk: journal_voucher.insertId,
                    journal_date: order.order_datetime,
                    account_id_fk: receivablesAccount.id,
                    partner_id_fk: order.customer_id,
                    debit: order.total_amount,
                    database_id: database_id,
                };

                await connection.query(
                    `INSERT INTO journal_items SET ?`,
                    firstItem,
                );
            } else {
                if (payment.cash_amount) {
                    const [cashAccount] =
                        await Accounts.getIdByAccountNumber("531");
                    const cashDollar = {
                        journal_id_fk: journal_voucher.insertId,
                        journal_date: order.order_datetime,
                        account_id_fk: cashAccount.id,
                        debit: payment.cash_amount,
                        database_id: database_id,
                    };
                    await connection.query(
                        `INSERT INTO journal_items SET ?`,
                        cashDollar,
                    );
                }
                if (payment.whish_amount) {
                    const [whishAccount] =
                        await Accounts.getIdByAccountNumber("532");
                    const whishDollar = {
                        journal_id_fk: journal_voucher.insertId,
                        journal_date: order.order_datetime,
                        account_id_fk: whishAccount.id,
                        debit: payment.whish_amount,
                        database_id: database_id,
                    };
                    await connection.query(
                        `INSERT INTO journal_items SET ?`,
                        whishDollar,
                    );
                }
            }

            const [result] = await connection.query(
                `INSERT INTO sales_orders SET ?`,
                order,
            );

            let order_id = result.insertId;

            // generate invoice_number
            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number, 4) AS UNSIGNED)), 1000) + 1 AS number FROM sales_orders`,
            );

            let invoice_number = `INV${number.toString().padStart(4, "0")}`;

            // let invoice_number = invoice.invoice_number;
            await connection.query(
                `UPDATE sales_orders SET invoice_number = ? WHERE order_id = ?`,
                [invoice_number, order_id],
            );
            await connection.query(
                `UPDATE journal_vouchers SET journal_number = ? WHERE journal_id = ?`,
                [invoice_number, journal_voucher.insertId],
            );

            // The avg_cost snapshot is read from inventory HERE, inside the transaction —
            // never taken from the request body. The client captures it when the sell
            // screen loads and echoes it back at checkout, so it is stale by however long
            // the cashier took, and it is trivially forgeable. It matters well beyond this
            // row: deleteOrder() and editOrder() restore inventory value from this exact
            // number, and ReportModel publishes it as COGS, so a wrong snapshot here is a
            // deferred leak that only surfaces when the invoice is later reversed.
            const productIds = [
                ...new Set(Array.from(items).map((i) => i.product_id)),
            ];
            const liveAvgCost = new Map();
            if (productIds.length > 0) {
                const [costRows] = await connection.query(
                    `SELECT product_id_fk, avg_cost_usd FROM inventory
					WHERE product_id_fk IN (?) AND database_id = ? AND is_deleted = 0`,
                    [productIds, database_id],
                );
                for (const row of costRows) {
                    liveAvgCost.set(
                        row.product_id_fk,
                        Number(row.avg_cost_usd) || 0,
                    );
                }
            }

            let invoice_map = Array.from(items).map(function (item) {
                // Fall back to the client's figure only when this tenant has no inventory
                // row for the product, or its average is unset — the same order of
                // preference the reversal paths use.
                const serverAvg = liveAvgCost.get(item.product_id) || 0;
                return [
                    order_id,
                    item.product_id,
                    item.quantity,
                    item.unit_price,
                    item.price_type,
                    item.unit_cost,
                    item.quantity * item.unit_price,
                    serverAvg > 0 ? serverAvg : item.avg_cost,
                ];
            });

            await connection.query(
                `INSERT INTO sales_order_items (order_id, product_id, quantity,  unit_price, price_type,unit_cost, total_price, avg_cost) VALUES ?`,
                [invoice_map],
            );

            // modify qty for stock managed items

            if (items.length > 0) {
                let queries = "";
                let product_id = null;
                let quantity = null;
                let params = [];
                items.forEach((element) => {
                    product_id = element["product_id"];
                    quantity = element["quantity"];
                    params = params.concat([
                        product_id,
                        database_id,
                        quantity,
                        order_id,
                        invoice_number,
                    ]);
                    //add order_items to inventory transactions
                    queries += `INSERT INTO inventory_transactions (product_id_fk, database_id, quantity, transaction_type, order_id_fk, transaction_notes) VALUES (?, ?, -?, 'SALE', ?, ?);`;
                });
                await connection.query(queries, params);
            }

            if (payment && order.customer_id) {
                const [_413] = await Accounts.getIdByAccountNumber("413");

                // register cash payment
                if (payment.cash_amount) {
                    payment.payment_date = moment(order.order_datetime)
                        .add(1, "seconds")
                        .format(`YYYY-MM-DD HH:mm:ss`);

                    let [[{ number }]] = await connection.query(
                        `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'PAY%'`,
                    );

                    let payment_number = `PAY${number.toString().padStart(4, "0")}`;

                    //insert to vouchers and journal_items
                    let query = `INSERT INTO journal_vouchers ( database_id, journal_number, journal_date, journal_description, journal_notes, total_value) VALUES (?, ?, ?, ?, ?, ?)`;
                    const [journal_voucher] = await connection.query(query, [
                        database_id,
                        payment_number,
                        payment.payment_date,
                        "Payment Received",
                        "531",
                        payment.cash_amount,
                    ]);

                    const [_531] = await Accounts.getIdByAccountNumber("531");
                    // const [_532] = await Accounts.getIdByAccountNumber("532");

                    const customer_name = await Customer.getCustomerNameById(
                        payment.customer_id,
                    );

                    const firstItem = {
                        database_id: database_id,
                        journal_id_fk: journal_voucher.insertId,
                        journal_date: payment.payment_date,
                        account_id_fk: _531.id,
                        debit: payment.cash_amount,
                        notes: customer_name,
                    };

                    await connection.query(
                        `INSERT INTO journal_items SET ?`,
                        firstItem,
                    );

                    const secondItem = {
                        database_id: database_id,
                        journal_id_fk: journal_voucher.insertId,
                        journal_date: payment.payment_date,
                        account_id_fk: _413.id,
                        partner_id_fk: payment.customer_id,
                        credit: payment.cash_amount,
                    };
                    await connection.query(
                        `INSERT INTO journal_items SET ?`,
                        secondItem,
                    );
                }

                // register whish payment
                if (payment.whish_amount) {
                    payment.payment_date = moment(order.order_datetime)
                        .add(1, "seconds")
                        .format(`YYYY-MM-DD HH:mm:ss`);

                    const [[{ number }]] = await connection.query(
                        `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'PAY%'`,
                    );

                    const payment_number = `PAY${number.toString().padStart(4, "0")}`;

                    //insert to vouchers and journal_items
                    const query = `INSERT INTO journal_vouchers ( database_id, journal_number, journal_date, journal_description, journal_notes, total_value) VALUES (?, ?, ?, ?, ?, ?)`;
                    const [journal_voucher] = await connection.query(query, [
                        database_id,
                        payment_number,
                        payment.payment_date,
                        "Payment Received",
                        "532",
                        payment.whish_amount,
                    ]);

                    const [_532] = await Accounts.getIdByAccountNumber("532");

                    const customer_name = await Customer.getCustomerNameById(
                        payment.customer_id,
                    );

                    const firstItem = {
                        database_id: database_id,
                        journal_id_fk: journal_voucher.insertId,
                        journal_date: payment.payment_date,
                        account_id_fk: _532.id,
                        reference_number: payment.reference_number,
                        partner_id_fk: null,
                        debit: payment.whish_amount,
                        credit: 0,
                        notes: customer_name,
                    };

                    await connection.query(
                        `INSERT INTO journal_items SET ?`,
                        firstItem,
                    );

                    const secondItem = {
                        database_id: database_id,
                        journal_id_fk: journal_voucher.insertId,
                        journal_date: payment.payment_date,
                        account_id_fk: _413.id,
                        reference_number: payment.reference_number,
                        partner_id_fk: payment.customer_id,
                        debit: 0,
                        credit: payment.whish_amount,
                    };
                    await connection.query(
                        `INSERT INTO journal_items SET ?`,
                        secondItem,
                    );
                }
            }

            await connection.commit();
            return { order: order_id, payment: journal_voucher.insertId };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // edit order
    // `payment` is the tender split for a CASH invoice: { cash_amount, whish_amount }.
    // It is ignored for a debt invoice — a debt sale is settled through its own
    // 'Payment Received' (PAY) vouchers, which this method neither reads nor writes.
    static async editOrder(order, items, database_id, payment) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            let order_id = order.order_id;

            if (!Array.isArray(items) || items.length === 0)
                throw new Error("An invoice must have at least one item.");

            //check existing order for user
            // is_deleted = 0 stops a soft-deleted invoice being resurrected: deleteOrder()
            // writes compensating 'DELETE' stock rows that the 'SALE' cleanup below can
            // never remove, so the resurrected invoice would double-count stock forever.
            // FOR UPDATE serialises concurrent PUTs, which would otherwise both pass the
            // check, both delete, and then collide on the explicit journal_id re-insert.
            let [[orderCheck]] = await connection.query(
                `SELECT * FROM sales_orders
				WHERE order_id = ? AND database_id = ? AND is_deleted = 0
				FOR UPDATE`,
                [order_id, database_id],
            );
            if (!orderCheck) throw new Error("Order not found");

            // The stored order_type is authoritative — never the request body. A cash
            // invoice posts to the money accounts (531/532) and a debt invoice to
            // receivables (4111), so the type decides the entire journal shape.
            const is_cash = orderCheck.order_type === "cash";

            // Changing type would mean moving money between 531/532 and 4111 and
            // unwinding the PAY vouchers. That is a delete plus a re-create, not an edit.
            if (order.order_type && order.order_type !== orderCheck.order_type)
                throw new Error(
                    "Invoice type cannot be changed. Delete the invoice and create a new one.",
                );
            if (is_cash && order.customer_id)
                throw new Error("A cash invoice cannot have a customer.");
            if (!is_cash && !order.customer_id)
                throw new Error("Customer is required for a debt invoice.");

            // Money is handled in integer cents. debit/credit/total_amount are all
            // DECIMAL(10,2), so anything finer is not representable; converting once at
            // the edge makes the voucher balance by construction rather than by luck.
            const toCents = (value) => Math.round((Number(value) || 0) * 100);
            const fromCents = (cents) => cents / 100;

            // The ledger total is DERIVED from the lines, never trusted from the body —
            // sales_order_items.total_price is written as quantity * unit_price below, so
            // a body total that disagreed would silently unbalance the voucher.
            const total_cents = items.reduce(
                (sum, item) =>
                    sum + toCents(item.quantity * item.unit_price),
                0,
            );
            const total_amount = fromCents(total_cents);

            // Cash tender split. Must add up to the invoice total, or the voucher would
            // not balance. Whish-only and cash-only are just the zero cases of a split.
            let cash_cents = 0;
            let whish_cents = 0;
            if (is_cash) {
                if (!payment)
                    throw new Error(
                        "A cash invoice requires a payment split.",
                    );
                cash_cents = toCents(payment.cash_amount);
                whish_cents = toCents(payment.whish_amount);
                if (cash_cents < 0 || whish_cents < 0)
                    throw new Error("Payment amounts cannot be negative.");
                if (cash_cents + whish_cents !== total_cents)
                    throw new Error(
                        "Cash + Whish must equal the invoice total.",
                    );
            }

            // ##############################################################################################
            // ################## reconcile the weighted average cost with the edit #########################
            // Editing an invoice moves stock: reducing a line puts units BACK, increasing one takes
            // more out. The quantity side of that happens below, by rewriting the 'SALE' rows — but
            // quantity and cost are separate levers here (inventory has no quantity column; value is
            // derived as SUM(inventory_transactions.quantity) * inventory.avg_cost_usd), so moving
            // only the first one silently invents or destroys inventory value.
            //
            // Returned units must be restored at the cost they were relieved at — the avg_cost
            // snapshotted on the original line — exactly as deleteOrder does. Restoring them at
            // today's average instead leaks (returned_qty * (today_avg - snapshot_avg)) on every
            // edit, and leaves the average wrong for the whole remaining pool, not just those units.
            //
            // Read before ANY of the rewrites below: the ledger delete/insert changes on-hand, and
            // the sales_order_items delete destroys the snapshots this depends on.
            const [oldLines] = await connection.query(
                `SELECT
					product_id,
					SUM(quantity) AS old_qty,
					SUM(CASE WHEN COALESCE(NULLIF(avg_cost, 0), NULLIF(unit_cost, 0)) IS NULL
						THEN 0 ELSE quantity END) AS costed_qty,
					SUM(quantity * COALESCE(NULLIF(avg_cost, 0), NULLIF(unit_cost, 0), 0)) AS old_value
				FROM sales_order_items
				WHERE order_id = ? AND is_deleted = 0
				GROUP BY product_id
				ORDER BY product_id`,
                [order_id],
            );

            // what the invoice will hold after the edit, aggregated per product
            const newQtyByProduct = new Map();
            for (const item of items) {
                newQtyByProduct.set(
                    item.product_id,
                    (newQtyByProduct.get(item.product_id) || 0) +
                        (Number(item.quantity) || 0),
                );
            }

            // The cost each re-inserted line should carry. Units still on the invoice keep the
            // original snapshot; units added during the edit are relieved at today's average, so a
            // line that grew carries the blend of the two. Without this a later deleteOrder would
            // restore less value than the edit relieved and destroy the difference permanently.
            const costSnapshots = new Map();

            for (const line of oldLines) {
                const oldQty = Number(line.old_qty) || 0;
                const costedQty = Number(line.costed_qty) || 0;
                const oldValue = Number(line.old_value) || 0;
                const newQty = newQtyByProduct.get(line.product_id) || 0;

                // No recoverable cost on the original line: leave the average alone rather than
                // valuing the returned units at zero.
                if (!(costedQty > 0)) continue;
                const oldAvg = oldValue / costedQty;
                costSnapshots.set(line.product_id, oldAvg);

                const delta = oldQty - newQty;
                if (delta === 0) continue;

                // Lock the inventory row for the read-modify-write, and take on-hand BEFORE the
                // ledger rewrite below. Lock order is ascending by product (the ORDER BY above),
                // matching deleteOrder so the two paths cannot deadlock.
                const [[inventoryRow]] = await connection.query(
                    `SELECT avg_cost_usd FROM inventory
					WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0
					FOR UPDATE`,
                    [line.product_id, database_id],
                );
                if (!inventoryRow) continue;

                const [[qtyRow]] = await connection.query(
                    `SELECT COALESCE(SUM(quantity), 0) AS quantity
					FROM inventory_transactions
					WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                    [line.product_id, database_id],
                );

                // mysql2 returns DECIMAL and SUM() over INT as strings — coerce before arithmetic.
                const currentAvgCost = Number(inventoryRow.avg_cost_usd);
                const currentQty = Math.max(Number(qtyRow.quantity), 0);

                if (delta > 0) {
                    // Units came back. Re-blend them in at the cost they left at.
                    const restoredValue = delta * oldAvg;
                    const newAvgCost =
                        currentQty === 0 || currentAvgCost === 0
                            ? oldAvg
                            : (currentQty * currentAvgCost + restoredValue) /
                              (currentQty + delta);

                    // Round to the stored scale before deciding anything: avg_cost_usd is
                    // DECIMAL(10,2), and letting MySQL round on store would persist a value the
                    // guards never saw.
                    const rounded = Math.round(newAvgCost * 100) / 100;
                    if (
                        !Number.isFinite(rounded) ||
                        rounded < 0.01 ||
                        rounded > 99999999.99
                    )
                        continue;

                    await connection.query(
                        `UPDATE inventory SET avg_cost_usd = ?
						WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                        [rounded, line.product_id, database_id],
                    );
                } else {
                    // The line grew. The extra units are relieved at today's average, which leaves
                    // the average itself unchanged (that is what a sale does) — but the line's
                    // snapshot must now describe both batches.
                    const extra = -delta;
                    if (newQty > 0 && currentAvgCost > 0) {
                        costSnapshots.set(
                            line.product_id,
                            (oldQty * oldAvg + extra * currentAvgCost) / newQty,
                        );
                    }
                }
            }

            // delete items from inventory transactions
            await connection.query(
                `DELETE FROM inventory_transactions WHERE order_id_fk = ? AND transaction_type = 'SALE' AND database_id = ?`,
                [order_id, database_id],
            );

            //add order_items to inventory transactions
            let inventoryQueries = "";
            let product_id = null;
            let quantity = null;
            items.forEach((element) => {
                product_id = element.product_id;
                quantity = element.quantity;
                // update inventory
                inventoryQueries += `INSERT INTO inventory_transactions (product_id_fk, database_id, transaction_type, transaction_datetime, quantity, order_id_fk, transaction_notes) VALUES (${product_id}, ${database_id}, 'SALE', '${
                    orderCheck.order_datetime
                }', ${-quantity}, ${order_id}, '${
                    orderCheck.invoice_number
                }');`;
            });
            await connection.query(inventoryQueries);

            //delete voucher and items
            let deleteVoucherQuery = `DELETE FROM journal_vouchers WHERE journal_id = ?`;
            await connection.query(
                deleteVoucherQuery,
                orderCheck.journal_voucher_id,
            );

            let deleteJournalItemsQuery = `DELETE FROM journal_items WHERE journal_id_fk = ?`;
            await connection.query(
                deleteJournalItemsQuery,
                orderCheck.journal_voucher_id,
            );

            // delete old items
            let deleteItemsQuery = `DELETE FROM sales_order_items WHERE order_id = ?`;
            await connection.query(deleteItemsQuery, order_id);

            // delete old invoice
            let deleteOrderQuery = `DELETE FROM sales_orders WHERE order_id = ?`;
            await connection.query(deleteOrderQuery, order_id);

            // insert the new order

            // fix date
            // order.order_datetime = moment(order.order_datetime).format(
            // 	`YYYY-MM-DD ${moment().format("HH:mm:ss")}`
            // );
            order.order_datetime = orderCheck.order_datetime;

            // fix invoice number
            order.invoice_number = `INV${order.invoice_number.padStart(
                4,
                "0",
            )}`;

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers (journal_id, database_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                orderCheck.journal_voucher_id,
                database_id,
                order.invoice_number,
                order.order_datetime,
                "Invoice",
                total_amount,
            ]);
            order.journal_voucher_id = journal_voucher.insertId;

            // Debit side. Mirrors addOrder: a debt sale debits receivables against the
            // customer; a cash sale debits the money accounts it was actually tendered
            // into, and has no partner at all. Posting 4111 for a cash sale — which is
            // what this method did before — creates a receivable owed by nobody and
            // makes the cash drawer disappear, while still balancing against 7011, so
            // no debit=credit check would ever catch it.
            if (is_cash) {
                if (cash_cents > 0) {
                    const [_531] = await Accounts.getIdByAccountNumber("531");
                    await connection.query(`INSERT INTO journal_items SET ?`, {
                        database_id: database_id,
                        journal_id_fk: journal_voucher.insertId,
                        journal_date: order.order_datetime,
                        account_id_fk: _531.id,
                        debit: fromCents(cash_cents),
                        credit: 0,
                    });
                }
                if (whish_cents > 0) {
                    const [_532] = await Accounts.getIdByAccountNumber("532");
                    await connection.query(`INSERT INTO journal_items SET ?`, {
                        database_id: database_id,
                        journal_id_fk: journal_voucher.insertId,
                        journal_date: order.order_datetime,
                        account_id_fk: _532.id,
                        debit: fromCents(whish_cents),
                        credit: 0,
                    });
                }
            } else {
                let [_4111] = await Accounts.getIdByAccountNumber("4111");

                const firstItem = {
                    database_id: database_id,
                    journal_id_fk: journal_voucher.insertId,
                    journal_date: order.order_datetime,
                    account_id_fk: _4111.id,
                    reference_number: order.reference_number,
                    partner_id_fk: order.customer_id,
                    debit: total_amount,
                    credit: 0,
                };

                await connection.query(
                    `INSERT INTO journal_items SET ?`,
                    firstItem,
                );
            }

            let [_7011] = await Accounts.getIdByAccountNumber("7011");
            const secondItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: order.order_datetime,
                account_id_fk: _7011.id,
                reference_number: order.reference_number,
                partner_id_fk: null,
                debit: 0,
                credit: total_amount,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                secondItem,
            );

            // Rebuild the row from explicit columns instead of `SET ?` on the raw request
            // body. The body carries no order_type, so the old code let MySQL apply the
            // column default ('debt') and silently reclassified every edited cash invoice
            // as a debt owed by nobody. Anything not restated here is lost on every edit.
            const newOrder = {
                order_id: order_id,
                invoice_number: order.invoice_number,
                journal_voucher_id: journal_voucher.insertId,
                customer_id: is_cash ? null : order.customer_id,
                database_id: database_id,
                order_type: orderCheck.order_type,
                order_datetime: order.order_datetime,
                total_amount: total_amount,
                total_cost: order.total_cost ?? orderCheck.total_cost,
                is_deleted: 0,
            };

            // insert query
            const [result] = await connection.query(
                `INSERT INTO sales_orders SET ?`,
                newOrder,
            );

            let invoice_map = Array.from(items).map(function (item) {
                return [
                    order_id,
                    item.product_id,
                    item.quantity,
                    item.unit_price,
                    item.price_type,
                    item.unit_cost,
                    item.quantity * item.unit_price,
                    // Server-computed snapshot, not the client's. The client echoes back
                    // whatever avg_cost it was handed when the dialog opened, which is stale
                    // for any line whose quantity grew — and that stale value is what a later
                    // deleteOrder would restore, destroying the difference.
                    costSnapshots.get(item.product_id) ?? item.avg_cost,
                ];
            });

            // avg_cost must be carried through the edit. The old rows are hard-deleted
            // above, so dropping the column here permanently loses the cost snapshot that
            // deleteOrder() and the COGS report both read.
            const [new_order] = await connection.query(
                `INSERT INTO sales_order_items (order_id, product_id, quantity,  unit_price, price_type,unit_cost, total_price, avg_cost ) VALUES ?`,
                [invoice_map],
            );

            await connection.commit();
            // Return the order id, not the items insertId — the controller looks the
            // order back up by this value.
            return order_id;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // delete invoice
    static async deleteOrder(order_id, database_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            //check existing order for user
            // `is_deleted = 0` makes this method idempotent. Without it a retry or a
            // double click credits the stock back twice — and now the cost too, which
            // is unrecoverable because the pre-delete average is stored nowhere.
            let [[orderCheck]] = await connection.query(
                `
				SELECT * FROM sales_orders WHERE order_id = ? AND database_id = ? AND is_deleted = 0`,
                [order_id, database_id],
            );
            if (!orderCheck) throw new Error("Order not found");

            // ##############################################################################################
            // ####################### restore the weighted average cost ####################################
            // A sale removes `quantity * avg_cost` of value from the inventory pool, which
            // is why posting one leaves avg_cost_usd alone. Deleting the sale has to put
            // that same value back — not whatever value today's average implies — otherwise
            // the stock valuation in ReportModel.getStockValue() gains the deleted invoice's
            // margin with no offsetting entry anywhere.
            //
            // Aggregated per product, because one product can appear on two lines and its
            // average must be blended once, against a single denominator.
            //
            // `avg_cost` is the average snapshotted when the sale was posted; it falls back
            // to `unit_cost` exactly the way the COGS report does (ReportModel.js:48), so the
            // value restored to the balance sheet equals the COGS this deletion removes from
            // the profit report. NULLIF(...,0) is needed as well as IS NULL because the sell
            // screen persists a literal 0.00 when it has no average to send.
            const [reversalLines] = await connection.query(
                `SELECT
					product_id,
					SUM(CASE WHEN COALESCE(NULLIF(avg_cost, 0), NULLIF(unit_cost, 0)) IS NULL
						THEN 0 ELSE quantity END) AS costed_qty,
					SUM(quantity * COALESCE(NULLIF(avg_cost, 0), NULLIF(unit_cost, 0), 0)) AS restored_value
				FROM sales_order_items
				WHERE order_id = ? AND is_deleted = 0
				GROUP BY product_id
				ORDER BY product_id`,
                [order_id],
            );

            // Every read here must happen before the reversing rows are written below,
            // so the average is blended against the quantity on hand BEFORE the restore.
            for (const line of reversalLines) {
                // Lock the inventory row for the whole read-modify-write. Otherwise a
                // concurrent purchase on the same product reads the same pre-state and
                // one of the two updates is silently discarded.
                const [[inventoryRow]] = await connection.query(
                    `SELECT avg_cost_usd FROM inventory
					WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0
					FOR UPDATE`,
                    [line.product_id, database_id],
                );

                const [[qtyRow]] = await connection.query(
                    `SELECT COALESCE(SUM(quantity), 0) AS quantity
					FROM inventory_transactions
					WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                    [line.product_id, database_id],
                );

                // mysql2 returns every DECIMAL — and SUM() over an INT column — as a
                // string, so coerce before any arithmetic: "5" + 1 is "51".
                const costedQty = Number(line.costed_qty);

                // No line carried a recoverable cost: restore the quantity anyway, but
                // leave the average alone rather than valuing the units at zero.
                if (!inventoryRow || !(costedQty > 0)) continue;

                const restoredValue = Number(line.restored_value);
                const currentAvgCost = Number(inventoryRow.avg_cost_usd);
                // Sales are not stock-checked, so on-hand can legitimately be negative.
                // Clamping keeps the divisor >= 1 (costedQty is >= 1 here): an unclamped
                // negative on-hand can zero the divisor — NULL into a NOT NULL column,
                // which rolls the whole deletion back — or invert the sign of the result.
                const currentQty = Math.max(Number(qtyRow.quantity), 0);

                const newAvgCost =
                    currentQty === 0 || currentAvgCost === 0
                        ? restoredValue / costedQty
                        : (currentQty * currentAvgCost + restoredValue) /
                          (currentQty + costedQty);

                // Round to the stored scale before deciding anything. avg_cost_usd is
                // DECIMAL(10,2); letting MySQL round on store would persist a value the
                // range checks never saw, and the residue is real money spread over the
                // whole pool. Matches PurchaseModel.deleteOrder.
                const rounded = Math.round(newAvgCost * 100) / 100;
                if (
                    !Number.isFinite(rounded) ||
                    rounded < 0.01 ||
                    rounded > 99999999.99
                )
                    continue;

                // unit_cost_usd is deliberately untouched — it means "last purchase
                // price", and deleting a sale does not change what we last paid.
                await connection.query(
                    `UPDATE inventory SET avg_cost_usd = ?
					WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                    [rounded, line.product_id, database_id],
                );
            }

            // add deleted items to inventory transactions
            await connection.query(
                `INSERT INTO inventory_transactions (product_id_fk, database_id, transaction_type, quantity, transaction_notes) SELECT product_id, ?, 'DELETE', quantity, '${orderCheck.invoice_number}' FROM sales_order_items WHERE order_id = ? AND is_deleted = 0`,
                [database_id, order_id],
            );

            //delete voucher and items
            let deleteVoucherQuery = `DELETE FROM journal_vouchers WHERE journal_id = ?`;
            await connection.query(
                deleteVoucherQuery,
                orderCheck.journal_voucher_id,
            );

            let deleteJournalItemsQuery = `DELETE FROM journal_items WHERE journal_id_fk = ?`;
            await connection.query(
                deleteJournalItemsQuery,
                orderCheck.journal_voucher_id,
            );

            // delete old items
            let deleteItemsQuery = `UPDATE sales_order_items SET is_deleted = 1 WHERE order_id = ?`;
            await connection.query(deleteItemsQuery, order_id);

            // delete old invoice
            let deleteOrderQuery = `UPDATE sales_orders SET is_deleted = 1 WHERE order_id = ?`;
            await connection.query(deleteOrderQuery, order_id);

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // get added order by id
    static async getAddedOrderById(order_id, database_id) {
        const [[order]] = await pool.query(
            `SELECT
                A.name AS customer_name,
                A.phone AS customer_phone,
                A.address AS customer_address,
                O.*,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('order_item_id', M.order_item_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'price_type', M.price_type,'unit_cost', M.unit_cost, 'unit_price', M.unit_price, 'total_price', M.total_price)) items
            FROM sales_orders O
            INNER JOIN sales_order_items M ON O.order_id = M.order_id
            INNER JOIN products S ON S.product_id = M.product_id
            LEFT JOIN accounts  A ON O.customer_id = A.account_id
            WHERE O.is_deleted = 0 AND O.order_id = ? AND O.database_id = ?
			GROUP BY O.order_id`,
            [order_id, database_id],
        );
        return order;
    }

    // Current tender split of a cash invoice. There is no cash_amount/whish_amount
    // column — the 531-vs-532 breakdown exists only as journal_items on the invoice
    // voucher, and editOrder deletes those before rebuilding, so the edit screen has
    // to read the split up front in order to pre-fill it.
    static async getOrderPayment(order_id, database_id) {
        const [[order]] = await pool.query(
            `SELECT order_id, order_type, journal_voucher_id, total_amount
            FROM sales_orders
            WHERE order_id = ? AND database_id = ? AND is_deleted = 0`,
            [order_id, database_id],
        );
        if (!order) throw new Error("Order not found");

        const [rows] = await pool.query(
            `SELECT C.account_number, SUM(J.debit) AS amount
            FROM journal_items J
            INNER JOIN chart_of_accounts C ON C.id = J.account_id_fk
            WHERE J.journal_id_fk = ? AND C.account_number IN ('531', '532')
            GROUP BY C.account_number`,
            [order.journal_voucher_id],
        );

        const find = (account_number) =>
            Number(
                rows.find((r) => r.account_number === account_number)?.amount,
            ) || 0;

        return {
            order_id: order.order_id,
            order_type: order.order_type,
            total_amount: Number(order.total_amount),
            cash_amount: find("531"),
            whish_amount: find("532"),
        };
    }
}

module.exports = SellOrders;
