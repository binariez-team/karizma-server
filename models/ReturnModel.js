const pool = require("../config/database");
const moment = require("moment-timezone");
const Accounts = require("./AccountsModel");

class ReturnModel {
    /**
     * Move the value of returned goods into or out of the weighted average.
     *
     * `direction` is +1 when goods come back from the customer (a RETURN) and -1 when
     * that return is undone (a REVERSERETURN, on edit or delete). Value in and value
     * out use the same per-line cost, so a return is reversible without leaking even
     * if the pool's average has moved in between — which it has on 44% of the return
     * lines currently in the database.
     *
     * Must be called BEFORE the matching inventory_transactions rows are written: the
     * blend has to see the quantity on hand without the units being moved.
     *
     * `lines` need `product_id`, `quantity` and `avg_cost` (falling back to
     * `unit_cost`, exactly as ReportModel.getReturns:76 does when it prices a return).
     */
    static async applyReturnCost(connection, database_id, lines, direction) {
        // one product can appear on two lines of the same return — blend it once
        const perProduct = new Map();
        for (const line of lines) {
            const qty = Number(line.quantity) || 0;
            const cost =
                Number(line.avg_cost) || Number(line.unit_cost) || 0;
            if (!(qty > 0) || !(cost > 0)) continue;
            const acc = perProduct.get(line.product_id) || { qty: 0, value: 0 };
            acc.qty += qty;
            acc.value += qty * cost;
            perProduct.set(line.product_id, acc);
        }

        // ascending product order keeps the lock order deterministic and matching the
        // other cost paths, so they cannot deadlock against each other
        for (const product_id of [...perProduct.keys()].sort((a, b) => a - b)) {
            const { qty, value } = perProduct.get(product_id);

            const [[inventoryRow]] = await connection.query(
                `SELECT avg_cost_usd FROM inventory
				WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0
				FOR UPDATE`,
                [product_id, database_id],
            );
            if (!inventoryRow) continue;

            const [[qtyRow]] = await connection.query(
                `SELECT COALESCE(SUM(quantity), 0) AS quantity
				FROM inventory_transactions
				WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                [product_id, database_id],
            );

            // mysql2 returns DECIMAL and SUM() over INT as strings — coerce first.
            const currentAvgCost = Number(inventoryRow.avg_cost_usd) || 0;
            // Sales are not stock-checked, so on-hand can be negative; clamp before it
            // reaches the divisor.
            const currentQty = Math.max(Number(qtyRow.quantity), 0);

            const newQty = currentQty + direction * qty;
            const newValue = currentQty * currentAvgCost + direction * value;

            // Nothing left to carry an average (the reversal empties or oversells the
            // pool), or the pool is worth less than what is being taken out: leave the
            // average alone rather than storing a negative or a zero. Zero is not
            // neutral — PurchaseModel:123 reads a 0.00 average as "never calculated".
            if (!(newQty > 0) || !(newValue > 0)) continue;

            const newAvgCost =
                currentQty === 0 || currentAvgCost === 0
                    ? value / qty
                    : newValue / newQty;

            // Round to the stored scale before the range check — avg_cost_usd is
            // DECIMAL(10,2), so the guard should see the value that actually lands.
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
                [rounded, product_id, database_id],
            );
        }
    }

    static async addReturn(database_id, order, items, payment) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            order.order_datetime = moment(order.order_datetime).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );

            // generate invoice_number
            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number, 4) AS UNSIGNED)), 1000) + 1 AS number FROM return_orders`,
            );
            order.invoice_number = `RET${number.toString().padStart(4, "0")}`;

            //insert transactions to new journal_items approch
            let query = `INSERT INTO journal_vouchers (database_id, journal_date, journal_number,journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                order.order_datetime,
                order.invoice_number,
                "Return",
                order.total_amount,
            ]);
            order.journal_voucher_id = journal_voucher.insertId;

            let [_4111] = await Accounts.getIdByAccountNumber("4111");

            const firstItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: order.order_datetime,
                account_id_fk: _4111.id,
                reference_number: order.reference_number,
                partner_id_fk: order.customer_id,

                debit: 0,
                credit: order.total_amount,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                firstItem,
            );

            let [_7011] = await Accounts.getIdByAccountNumber("7011");
            const secondItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: order.order_datetime,
                account_id_fk: _7011.id,
                reference_number: order.reference_number,
                partner_id_fk: null,
                debit: order.total_amount,
                credit: 0,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                secondItem,
            );

            //add database_id to order
            order.database_id = database_id;

            //insert order
            const [result] = await connection.query(
                `INSERT INTO return_orders SET ?`,
                order,
            );
            let order_id = result.insertId;

            let invoice_map = Array.from(items).map(function (item) {
                return [
                    order_id,
                    item.product_id,
                    item.quantity,
                    item.unit_price,
                    item.price_type,
                    item.unit_cost,
                    item.avg_cost,
                    item.quantity * item.unit_price,
                ];
            });
            //insert order_items
            await connection.query(
                `INSERT INTO return_order_items (order_id, product_id, quantity, unit_price, price_type, unit_cost, avg_cost, total_price) VALUES ?`,
                [invoice_map],
            );

            // ##############################################################################################
            // ####################### blend the returned goods back into the pool ##########################
            // Returned units are an inflow and have to be valued. Because inventory holds no
            // value column — stock value is derived as SUM(inventory_transactions.quantity) *
            // avg_cost_usd — simply adding quantity already books the units in at TODAY's
            // average. That is only right when the line's recorded avg_cost happens to equal
            // today's average, so blend explicitly at the recorded cost instead: it is the same
            // number ReportModel.getReturns:76 publishes as the cost of the return, and the two
            // must agree or the stock value and the P&L describe different events.
            //
            // Doing it explicitly is also what makes the return REVERSIBLE: editReturn and
            // deleteReturn now remove exactly this value back out, so an edit or a delete after
            // the average has moved no longer leaks.
            //
            // Read before the RETURN rows are inserted below, so the blend runs against the
            // quantity on hand WITHOUT the returned units.
            await ReturnModel.applyReturnCost(connection, database_id, items, 1);

            // modify qty for stock managed items

            if (items.length > 0) {
                let queries = "";
                let product_id = null;
                let quantity = null;
                let params = [];
                items.forEach((element) => {
                    product_id = element["product_id"];
                    quantity = element["quantity"];
                    params = params.concat([product_id, database_id, quantity]);
                    //add order_items to inventory transactions
                    queries += `INSERT INTO inventory_transactions (product_id_fk, database_id, quantity, transaction_type) VALUES (?,?,?, 'RETURN');`;
                });
                await connection.query(queries, params);
            }

            if (payment) {
                payment.payment_date = moment(payment.payment_date).format(
                    `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
                );

                let [[{ number }]] = await connection.query(
                    `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'PAY%'`,
                );

                let payment_number = `PAY${number.toString().padStart(4, "0")}`;

                //insert to vouchers and journal_items
                let query = `INSERT INTO journal_vouchers ( database_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
                const [journal_voucher] = await connection.query(query, [
                    database_id,
                    payment_number,
                    payment.payment_date,
                    "Payment Returned",
                    payment.amount,
                ]);

                let [_531] = await Accounts.getIdByAccountNumber("531");

                const firstItem = {
                    journal_id_fk: journal_voucher.insertId,
                    journal_date: payment.payment_date,
                    account_id_fk: _531.id,
                    database_id: database_id,
                    reference_number: payment.reference_number,
                    partner_id_fk: null,

                    debit: 0,
                    credit: payment.amount,
                };

                await connection.query(
                    `INSERT INTO journal_items SET ?`,
                    firstItem,
                );

                let [_413] = await Accounts.getIdByAccountNumber("413");
                const secondItem = {
                    journal_id_fk: journal_voucher.insertId,
                    journal_date: payment.payment_date,
                    account_id_fk: _413.id,
                    reference_number: payment.reference_number,
                    partner_id_fk: payment.customer_id,
                    database_id: database_id,
                    debit: payment.amount,
                    credit: 0,
                };
                await connection.query(
                    `INSERT INTO journal_items SET ?`,
                    secondItem,
                );
            }

            await connection.commit();
            return { order: order_id };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // edit return
    static async editReturn(database_id, order, items) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            let order_id = order.order_id;

            //check existing order for user
            let [[orderCheck]] = await connection.query(
                `SELECT * FROM return_orders WHERE order_id = ? AND database_id = ?`,
                [order_id, database_id],
            );
            if (!orderCheck) throw new Error("Order not found");

            // update inventory qty for deleted items
            let inventoryQueries = "";
            let product_id = null;
            let quantity = null;

            // Take the ORIGINAL lines' value back out at the cost they came in at, before
            // anything is deleted or re-inserted. Reversing at today's average instead
            // would leak quantity * (today_avg - recorded_cost) on every edit — 44% of
            // live return lines already sit on a moved average.
            const [oldLines] = await connection.query(
                `SELECT product_id, quantity, avg_cost, unit_cost
				FROM return_order_items WHERE order_id = ?`,
                [order_id],
            );
            await ReturnModel.applyReturnCost(
                connection,
                database_id,
                oldLines,
                -1,
            );

            // add deleted items to inventory transactions
            // REVERSERETURN cancels a RETURN, so it must carry the opposite sign.
            // Every reader sums `quantity` as stored (AdminStockModel.js:44,
            // UserStockModel.js:35, ReportModel.js:19) — none of them flip the sign,
            // so a positive row here would add the returned stock a second time.
            await connection.query(
                `INSERT INTO inventory_transactions (product_id_fk, database_id, transaction_type, quantity) SELECT product_id, ?, 'REVERSERETURN', -quantity FROM return_order_items WHERE order_id = ?`,
                [database_id, order_id],
            );
            // ...then blend the replacement lines in, at their own recorded cost. Reading
            // on-hand here sees the REVERSERETURN rows above already applied, which is
            // correct: the old lines are gone by this point.
            await ReturnModel.applyReturnCost(connection, database_id, items, 1);

            //add order_items to inventory transactions
            items.forEach((element) => {
                product_id = element.product_id;
                quantity = element.quantity;
                // update inventory
                inventoryQueries += `INSERT INTO inventory_transactions (product_id_fk, database_id, transaction_type, quantity) VALUES (${product_id}, ${database_id}, 'RETURN', ${quantity});`;
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
            let deleteItemsQuery = `DELETE FROM return_order_items WHERE order_id = ?`;
            await connection.query(deleteItemsQuery, order_id);

            // delete old invoice
            let deleteOrderQuery = `DELETE FROM return_orders WHERE order_id = ?`;
            await connection.query(deleteOrderQuery, order_id);

            // insert the new order

            // fix date
            order.order_datetime = moment(order.order_datetime).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );

            // fix invoice number
            order.invoice_number = `RET${order.invoice_number.padStart(
                4,
                "0",
            )}`;

            //insert transactions to new journal_items approch
            let query = `INSERT INTO journal_vouchers (database_id, journal_date, journal_number,journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                order.order_datetime,
                order.invoice_number,
                "Return",
                order.total_amount,
            ]);
            order.journal_voucher_id = journal_voucher.insertId;

            let [_4111] = await Accounts.getIdByAccountNumber("4111");

            const firstItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: order.order_datetime,
                account_id_fk: _4111.id,
                reference_number: order.reference_number,
                partner_id_fk: order.customer_id,

                debit: 0,
                credit: order.total_amount,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                firstItem,
            );

            let [_7011] = await Accounts.getIdByAccountNumber("7011");
            const secondItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: order.order_datetime,
                account_id_fk: _7011.id,
                reference_number: order.reference_number,
                partner_id_fk: null,

                debit: order.total_amount,
                credit: 0,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                secondItem,
            );

            //add database_id to order
            order.database_id = database_id;

            // insert query
            const [result] = await connection.query(
                `INSERT INTO return_orders SET ?`,
                order,
            );

            let invoice_map = Array.from(items).map(function (item) {
                return [
                    order_id,
                    item.product_id,
                    item.quantity,
                    item.unit_price,
                    item.price_type,
                    item.unit_cost,
                    item.avg_cost,
                    item.quantity * item.unit_price,
                ];
            });

            const [new_order] = await connection.query(
                `INSERT INTO return_order_items (order_id, product_id, quantity,  unit_price, price_type, unit_cost, avg_cost, total_price ) VALUES ?`,
                [invoice_map],
            );

            await connection.commit();
            return new_order.insertId;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
    // fetch a single return order shaped like a sell invoice (for the result dialog)
    static async getAddedOrderById(order_id, database_id) {
        const [[order]] = await pool.query(
            `SELECT
                A.name AS customer_name,
                A.phone AS customer_phone,
                A.address AS customer_address,
                RO.*,
                DATE(RO.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('order_item_id', M.order_item_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'price_type', M.price_type,'unit_cost', M.unit_cost, 'unit_price', M.unit_price, 'total_price', M.total_price)) items
            FROM return_orders RO
            INNER JOIN return_order_items M ON RO.order_id = M.order_id
            INNER JOIN products S ON S.product_id = M.product_id
            INNER JOIN accounts  A ON RO.customer_id = A.account_id
            WHERE RO.is_deleted = 0 AND RO.order_id = ? AND RO.database_id = ?
            GROUP BY RO.order_id`,
            [order_id, database_id],
        );
        return order;
    }

    static async deleteReturn(database_id, order_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            //check existing order for user
            let [[orderCheck]] = await connection.query(
                `
				SELECT * FROM return_orders WHERE order_id = ? AND database_id = ?`,
                [order_id, database_id],
            );
            if (!orderCheck) throw new Error("Order not found");

            // Take the return's value back out at the cost it was booked in at, before
            // the reversing rows land and before the line rows are deleted below.
            // Reversing at today's average would leak the drift instead.
            const [oldLines] = await connection.query(
                `SELECT product_id, quantity, avg_cost, unit_cost
				FROM return_order_items WHERE order_id = ?`,
                [order_id],
            );
            await ReturnModel.applyReturnCost(
                connection,
                database_id,
                oldLines,
                -1,
            );

            // add deleted items to inventory transactions
            // REVERSERETURN cancels a RETURN, so it must carry the opposite sign —
            // see the note on the same statement in editOrder above.
            await connection.query(
                `INSERT INTO inventory_transactions (product_id_fk, database_id, transaction_type, quantity) SELECT product_id, ?, 'REVERSERETURN', -quantity FROM return_order_items WHERE order_id = ?`,
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
            let deleteItemsQuery = `DELETE FROM return_order_items WHERE order_id = ?`;
            await connection.query(deleteItemsQuery, order_id);

            // delete old invoice
            let deleteOrderQuery = `DELETE FROM return_orders WHERE order_id = ?`;
            await connection.query(deleteOrderQuery, order_id);

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = ReturnModel;
