const pool = require("../config/database");
const Accounts = require("./AccountsModel");
const Product = require("./AdminStockModel");
const moment = require("moment-timezone");

class PurchaseOrders {
    // add order
    static async addOrder(order, items, payment, user) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const database_id = user.database_id;

            moment.tz.setDefault("Asia/Beirut");
            order.order_datetime = moment(order.order_datetime).format(
                `YYYY-MM-DD HH:mm:ss`
            );

            let journal_voucher;
            //insert transactions to new journal_items approch
            let query = `INSERT INTO journal_vouchers (journal_date, database_id, journal_description, total_value) VALUES (?, ?, ?, ?)`;
            [journal_voucher] = await connection.query(query, [
                order.order_datetime,
                database_id,
                "Supply",
                order.total_cost,
            ]);
            order.journal_voucher_id = journal_voucher.insertId;

            // get 4011 account id
            let [_4011] = await Accounts.getIdByAccountNumber("4011");
            let firstItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: order.order_datetime,
                account_id_fk: _4011.id,
                reference_number: order.reference_number,
                partner_id_fk: order.partner_id_fk,
                debit: 0,
                credit: order.total_cost,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                firstItem
            );

            // get purchase account
            let [_6011] = await Accounts.getIdByAccountNumber("6011");
            let secondItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: order.order_datetime,
                account_id_fk: _6011.id,
                reference_number: order.reference_number,
                debit: order.total_cost,
                credit: 0,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                secondItem
            );

            // create purchase order
            const [createdOrder] = await connection.query(
                `INSERT INTO purchase_orders SET ?`,
                order
            );

            let order_id = createdOrder.insertId;

            // generate invoice_number
            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number, 4) AS UNSIGNED)), 1000) + 1 AS number FROM purchase_orders`
            );

            let invoice_number = `SUP${number.toString().padStart(4, "0")}`;

            // let invoice_number = invoice.invoice_number;
            await connection.query(
                `UPDATE purchase_orders SET invoice_number = ? WHERE order_id = ?`,
                [invoice_number, order_id]
            );

            // update journal voucher number
            await connection.query(
                `UPDATE journal_vouchers SET journal_number = ? WHERE journal_id = ?`,
                [invoice_number, journal_voucher.insertId]
            );

            // loop through order items
            for (const record of items) {
                let order_items = {
                    order_id_fk: order_id,
                    product_id_fk: record.product_id,
                    product_name: record.product_name,
                    quantity: record.quantity,
                    unit_cost_usd: record.unit_price,
                };
                await connection.query(
                    `INSERT INTO purchase_order_items SET ?`,
                    order_items
                );

                let [{ quantity }] = await Product.getById(
                    record.product_id,
                    database_id
                );

                // safe calculate quantity for negative stock
                if (quantity < 0) quantity = 0;

                // check old average cost
                let [[{ avg_cost_usd, unit_cost_usd }]] =
                    await connection.query(
                        `SELECT avg_cost_usd, unit_cost_usd FROM inventory WHERE product_id_fk = ? AND database_id = ?`,
                        [record.product_id, database_id]
                    );

                // set avg cost equals to unit cost if it is 0 or not been calculated
                if (!avg_cost_usd || avg_cost_usd == "0.00") {
                    avg_cost_usd = unit_cost_usd;
                }

                // update average cost, unit_cost, and selling price

                let avgCostToAdd = avg_cost_usd; // avg cost
                let originalPrice = record.unit_price; // original price to calculate new avg cost
                // let priceToAdd = record.selling_price; // updated selling price

                await connection.query(
                    `UPDATE inventory SET  unit_cost_usd = ?, avg_cost_usd = ((? * ?) + (? * ?)) / (? + ?) WHERE product_id_fk = ? AND database_id = ?`,
                    [
                        record.unit_price,
                        quantity,
                        avg_cost_usd,
                        record.quantity,
                        record.unit_price,
                        quantity,
                        record.quantity,
                        record.product_id,
                        database_id,
                    ]
                );

                await connection.query(
                    `UPDATE inventory SET grandwhole_price_usd = ?, whole_price_usd = ?, unit_price_usd = ? WHERE product_id_fk = ? AND database_id = ?`,
                    [
                        record.grandwhole_price_usd,
                        record.whole_price_usd,
                        record.unit_price_usd,
                        record.product_id,
                        database_id,
                    ]
                );

                // insert a transaction record
                await connection.query(
                    `INSERT INTO inventory_transactions SET ?`,
                    {
                        product_id_fk: record.product_id,
                        quantity: record.quantity,
                        transaction_type: "SUPPLY",
                        order_id_fk: order_id,
                        transaction_notes: invoice_number,
                        database_id: database_id,
                    }
                );
            }

            if (payment) {
                payment.payment_date = moment(payment.payment_date).format(
                    `YYYY-MM-DD HH:mm:ss`
                );

                let [[{ number }]] = await connection.query(
                    `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'REC%'`
                );

                let payment_number = `REC${number.toString().padStart(4, "0")}`;

                //insert to vouchers and journal_items
                let query = `INSERT INTO journal_vouchers ( journal_number, database_id, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
                const [journal_voucher] = await connection.query(query, [
                    payment_number,
                    database_id,
                    payment.payment_date,
                    "Supplier Payment",
                    payment.amount,
                ]);

                let [_531] = await Accounts.getIdByAccountNumber("531");

                const firstItem = {
                    journal_id_fk: journal_voucher.insertId,
                    journal_date: payment.payment_date,
                    account_id_fk: _531.id,
                    reference_number: payment.reference_number,
                    debit: 0,
                    credit: payment.amount,
                    database_id: database_id,
                };

                await connection.query(
                    `INSERT INTO journal_items SET ?`,
                    firstItem
                );

                let [_401] = await Accounts.getIdByAccountNumber("401");
                const secondItem = {
                    journal_id_fk: journal_voucher.insertId,
                    journal_date: payment.payment_date,
                    account_id_fk: _401.id,
                    reference_number: payment.reference_number,
                    partner_id_fk: payment.partner_id_fk,
                    debit: payment.amount,
                    credit: 0,
                    database_id: database_id,
                };
                await connection.query(
                    `INSERT INTO journal_items SET ?`,
                    secondItem
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

    // edit order
    static async editOrder(order, items, database_id) {
        // const connection = await pool.getConnection();
        // try {
        // 	await connection.beginTransaction();
        // 	let order_id = order.order_id;
        // 	//check existing order for user
        // 	let [[orderCheck]] = await connection.query(
        // 		`SELECT * FROM purchase_orders WHERE order_id = ?`,
        // 		[order_id]
        // 	);
        // 	if (!orderCheck) throw new Error("Order not found");
        // 	// update inventory qty for deleted items
        // 	let inventoryQueries = "";
        // 	let product_id = null;
        // 	let quantity = null;
        // 	// add deleted items to inventory transactions
        // 	await connection.query(
        // 		`DELETE FROM inventory_transactions WHERE order_id_fk = ? AND transaction_type = 'SUPPLY'`,
        // 		[order_id]
        // 	);
        // 	let product_ids = [];
        // 	let added_products_costs = [];
        // 	//add order_items to inventory transactions
        // 	items.forEach((element) => {
        // 		product_id = element.product_id;
        // 		quantity = element.quantity;
        // 		product_ids.push(product_id);
        // 		added_products_costs.push({
        // 			product_id,
        // 			quantity,
        // 			unit_cost: element["unit_price"],
        // 		});
        // 		// update inventory
        // 		inventoryQueries += `INSERT INTO inventory_transactions (product_id_fk, transaction_type, quantity, order_id_fk, transaction_notes) VALUES (${product_id}, 'SUPPLY', ${quantity}, ${order_id}, '${orderCheck.invoice_number}');`;
        // 	});
        // 	await connection.query(inventoryQueries);
        // 	//delete voucher and items
        // 	let deleteVoucherQuery = `DELETE FROM journal_vouchers WHERE journal_id = ?`;
        // 	await connection.query(
        // 		deleteVoucherQuery,
        // 		orderCheck.journal_voucher_id
        // 	);
        // 	let deleteJournalItemsQuery = `DELETE FROM journal_items WHERE journal_id_fk = ?`;
        // 	await connection.query(
        // 		deleteJournalItemsQuery,
        // 		orderCheck.journal_voucher_id
        // 	);
        // 	// delete old items
        // 	let deleteItemsQuery = `DELETE FROM purchase_order_items WHERE order_id_fk = ?`;
        // 	await connection.query(deleteItemsQuery, order_id);
        // 	// delete old invoice
        // 	let deleteOrderQuery = `DELETE FROM purchase_orders WHERE order_id = ?`;
        // 	await connection.query(deleteOrderQuery, order_id);
        // 	// insert the new order
        // 	// fix date
        // 	order.order_datetime = moment(order.order_datetime).format(
        // 		`YYYY-MM-DD HH:mm:ss`
        // 	);
        // 	// fix invoice number
        // 	order.invoice_number = `SUP${order.invoice_number.padStart(
        // 		4,
        // 		"0"
        // 	)}`;
        // 	//insert to vouchers and journal_items
        // 	let query = `INSERT INTO journal_vouchers (journal_id, journal_number, journal_date, journal_description, total_value, database_id) VALUES (?, ?, ?, ?, ?, ?)`;
        // 	const [journal_voucher] = await connection.query(query, [
        // 		orderCheck.journal_voucher_id,
        // 		order.invoice_number,
        // 		order.order_datetime,
        // 		"Supply",
        // 		order.total_cost,
        // 		database_id,
        // 	]);
        // 	order.journal_voucher_id = journal_voucher.insertId;
        // 	let [_4011] = await Accounts.getIdByAccountNumber("4011");
        // 	const firstItem = {
        // 		journal_id_fk: journal_voucher.insertId,
        // 		journal_date: order.order_datetime,
        // 		account_id_fk: _4011.id,
        // 		reference_number: order.reference_number,
        // 		partner_id_fk: order.partner_id_fk,
        // 		debit: 0,
        // 		credit: order.total_cost,
        // 	};
        // 	await connection.query(
        // 		`INSERT INTO journal_items SET ?`,
        // 		firstItem
        // 	);
        // 	let [_6011] = await Accounts.getIdByAccountNumber("6011");
        // 	const secondItem = {
        // 		journal_id_fk: journal_voucher.insertId,
        // 		journal_date: order.order_datetime,
        // 		account_id_fk: _6011.id,
        // 		reference_number: order.reference_number,
        // 		partner_id_fk: null,
        // 		debit: order.total_cost,
        // 		credit: 0,
        // 	};
        // 	await connection.query(
        // 		`INSERT INTO journal_items SET ?`,
        // 		secondItem
        // 	);
        // 	order.exchange_rate = orderCheck.exchange_rate;
        // 	// insert query
        // 	const [new_order] = await connection.query(
        // 		`INSERT INTO purchase_orders SET ?`,
        // 		order
        // 	);
        // 	let invoice_map = Array.from(items).map(function (item) {
        // 		return [
        // 			order_id,
        // 			item.product_id,
        // 			item.product_name,
        // 			item.quantity,
        // 			item.unit_price,
        // 			item.unit_abbreviation,
        // 			item.product_unit_id,
        // 		];
        // 	});
        // 	await connection.query(
        // 		`INSERT INTO purchase_order_items (order_id_fk, product_id_fk, product_name, quantity,  unit_cost_usd, product_unit_abbreviation, product_unit_id ) VALUES ?`,
        // 		[invoice_map]
        // 	);
        // 	if (product_ids.length > 0) {
        // 		//calculate avg cost and new unit_cost for each item
        // 		let product_ids_str = product_ids.join(",");
        // 		let [old_avg_cost] = await connection.query(
        // 			`SELECT product_id, coalesce(p.avg_cost_usd , unit_cost_usd) avg_cost_usd, unit_cost_usd FROM products p WHERE product_id IN  (${product_ids_str})`
        // 		);
        // 		let [product_qty] = await connection.query(
        // 			`SELECT product_id_fk,coalesce(sum(quantity),0) qty FROM inventory_transactions it  WHERE product_id_fk IN  (${product_ids_str}) GROUP BY product_id_fk `
        // 		);
        // 		let products_avg_cost = {};
        // 		let queries = "";
        // 		added_products_costs.forEach((element) => {
        // 			let product_id = element.product_id;
        // 			let quantity = element.quantity;
        // 			let unit_cost = parseFloat(element.unit_cost);
        // 			let old_cost = old_avg_cost.find(
        // 				(item) => item.product_id === product_id
        // 			);
        // 			let old_qty = product_qty.find(
        // 				(item) => item.product_id_fk === product_id
        // 			);
        // 			let old_avg = old_cost
        // 				? parseFloat(old_cost.avg_cost_usd)
        // 				: unit_cost;
        // 			let old_unit_cost = old_cost
        // 				? parseFloat(old_cost.unit_cost_usd)
        // 				: unit_cost;
        // 			let old_qty_val = old_qty ? parseFloat(old_qty.qty) : 0;
        // 			let new_avg =
        // 				(old_avg * old_qty_val + unit_cost * quantity) /
        // 				(old_qty_val + quantity);
        // 			products_avg_cost[product_id] = new_avg;
        // 			let max_cost = Math.max(old_unit_cost, unit_cost);
        // 			queries += `UPDATE products SET avg_cost_usd = ${new_avg}, unit_cost_usd = ${max_cost} WHERE product_id = ${product_id};`;
        // 		});
        // 		await connection.query(queries);
        // 	}
        // 	await connection.commit();
        // 	return new_order.insertId;
        // } catch (error) {
        // 	await connection.rollback();
        // 	throw error;
        // } finally {
        // 	connection.release();
        // }
    }

    // delete invoice
    static async deleteOrder(order_id, database_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            //check existing order for user
            // FOR UPDATE is load-bearing now that cost is reversed below. The header is
            // hard-deleted at the end, which only makes this method idempotent for
            // SEQUENTIAL retries: without the lock, a double click or a client retry lets
            // both transactions take their REPEATABLE READ snapshot before either commits,
            // so both see the order and both run the reversal. The loser's DELETE matches 0
            // rows, which is not an error, so both commit. That double-reverses the quantity
            // and — because the inventory lock below is a current read while the on-hand SUM
            // is a snapshot read — recomputes an average against a stale quantity. There is
            // no recovering it: avg_cost_usd has no history and purchase_order_items is
            // destroyed in the same transaction.
            //
            // Deliberately NOT filtered by database_id: purchase_orders.database_id is NULL
            // on every row, so that predicate would match nothing and no order could ever be
            // deleted. The tenant is taken from the ledger instead, and enforced below.
            let [[orderCheck]] = await connection.query(
                `
				SELECT * FROM purchase_orders WHERE order_id = ? FOR UPDATE`,
                [order_id]
            );
            if (!orderCheck) throw new Error("Order not found");

            // Tenant gate. The SUPPLY rows are the only record of which database this order
            // stocked, so they are the access-control source too. An order with no SUPPLY
            // rows at all (a few early orders have items but never posted to the ledger) is
            // allowed through — it has no stock impact to reverse or to leak.
            let [[{ foreign_supply_rows }]] = await connection.query(
                `SELECT COUNT(*) AS foreign_supply_rows FROM inventory_transactions
				WHERE order_id_fk = ? AND transaction_type = 'SUPPLY' AND database_id <> ?`,
                [order_id, database_id]
            );
            if (foreign_supply_rows > 0)
                throw new Error("Order not found");

            // ##############################################################################################
            // ################## remove this purchase's cost from the weighted average ####################
            // A purchase adds `quantity * unit_cost` of value to the pool and blends it into
            // avg_cost_usd (addOrder:134). Deleting it has to take that value back out, or the
            // quantity reversal below strips the units while their cost stays in the average and
            // ReportModel.getStockValue() keeps valuing the deleted invoice forever.
            //
            // This is value REMOVAL, not restatement. The pre-purchase average is unrecoverable:
            // addOrder overwrites avg_cost_usd in place and snapshots it nowhere, so there is no
            // purchase-side equivalent of sales_order_items.avg_cost. The invariant kept is
            // `pool = purchases booked - COGS as published` — COGS was snapshotted onto
            // sales_order_items.avg_cost at sale time and nothing here restates it. Same trade the
            // sale deletion makes in the opposite direction (SellOrdersModel.deleteOrder).
            //
            // Quantity and price are aggregated on their own sides and multiplied, never joined
            // row to row: one product can appear on two lines of an order and a fan-out join would
            // double both. The ledger is authoritative for HOW MANY (it holds the int actually
            // posted and the database_id); purchase_order_items only for the PRICE.
            //
            // No `is_deleted = 0` on the SUPPLY side — it has to match the INSERT ... SELECT below
            // exactly, so the quantity whose value is removed is the quantity actually reversed.
            // If that filter is ever added, add it to both statements in the same commit.
            const [reversalLines] = await connection.query(
                `SELECT
					T.product_id_fk AS product_id,
					T.database_id,
					SUM(T.quantity) AS supply_qty,
					MAX(T.transaction_id) AS this_cost_txn,
					(SELECT MAX(L.transaction_id) FROM inventory_transactions L
						WHERE L.product_id_fk = T.product_id_fk
							AND L.database_id = T.database_id
							AND L.transaction_type IN ('SUPPLY', 'DELIVER', 'DELETE')) AS last_cost_txn,
					MAX(I.line_qty) AS line_qty,
					MAX(I.line_value) AS line_value
				FROM inventory_transactions T
				LEFT JOIN (
					SELECT product_id_fk,
						SUM(quantity) AS line_qty,
						SUM(quantity * unit_cost_usd) AS line_value
					FROM purchase_order_items
					WHERE order_id_fk = ?
					GROUP BY product_id_fk
				) I ON I.product_id_fk = T.product_id_fk
				WHERE T.order_id_fk = ? AND T.transaction_type = 'SUPPLY'
					AND T.database_id = ?
				GROUP BY T.product_id_fk, T.database_id
				ORDER BY T.product_id_fk, T.database_id`,
                [order_id, order_id, database_id]
            );

            // Most groups skip, by design — on current data roughly 9 in 10. Count them so a
            // deletion that adjusted nothing is distinguishable from one that adjusted every
            // line, and so this is observable in production at all.
            const costReversal = {
                groups: reversalLines.length,
                adjusted: 0,
                skipped: 0,
            };

            // Every read in this loop must happen BEFORE the reversing 'DELETE' rows are inserted
            // below (so on-hand still includes this supply) and BEFORE purchase_order_items is
            // hard-deleted further down. Moving either write above this loop double-counts.
            for (const line of reversalLines) {
                // Lock the inventory row for the whole read-modify-write. addOrder does its own
                // read-modify-write with no lock (:116 -> :134), so a concurrent purchase would
                // otherwise recompute from the pre-delete state and discard this result. ORDER BY
                // above keeps lock order ascending by product, matching SellOrdersModel.deleteOrder
                // so the two deletion paths cannot deadlock against each other.
                const [[inventoryRow]] = await connection.query(
                    `SELECT avg_cost_usd FROM inventory
					WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0
					FOR UPDATE`,
                    [line.product_id, line.database_id]
                );

                const [[qtyRow]] = await connection.query(
                    `SELECT COALESCE(SUM(quantity), 0) AS quantity
					FROM inventory_transactions
					WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                    [line.product_id, line.database_id]
                );

                // mysql2 returns every DECIMAL — and SUM() over an INT column — as a string, so
                // coerce before any arithmetic: "5" + 1 is "51". line_qty / line_value come back
                // NULL when the LEFT JOIN found no surviving purchase line; Number(null) is 0,
                // which the `> 0` tests reject.
                const supplyQty = Number(line.supply_qty);
                const lineQty = Number(line.line_qty);
                const lineValue = Number(line.line_value);

                // No live inventory row for this tenant, nothing supplied on net, or no cost
                // record to price the reversal: undo the quantity below but leave the average
                // alone rather than valuing the removal at zero.
                if (!inventoryRow || !(supplyQty > 0) || !(lineQty > 0)) {
                    costReversal.skipped += 1;
                    continue;
                }

                // Something has REWRITTEN the average since this invoice posted, so its value is
                // no longer a component of what is stored and subtracting it would subtract from
                // a number this purchase never produced. Three writers do this and none blend:
                // DeliverModel.js:65 overwrites outright for database_id 1, SellOrdersModel
                // re-blends on sale deletion, and a previous run of this block may have adjusted
                // it. Each leaves a ledger row, so "is this invoice still the last cost event?" is
                // answerable. Without this guard, deleting a superseded invoice writes a price
                // belonging to no invoice at all — on live data it takes a product holding 11
                // units at 87.50 (all from a LATER order) down to 37.50 on its one surviving unit.
                // A manual edit (AdminStockModel.js:196) leaves no ledger row and is not
                // detectable here; that residual is accepted.
                if (Number(line.this_cost_txn) !== Number(line.last_cost_txn)) {
                    costReversal.skipped += 1;
                    continue;
                }

                // What this invoice charged per unit. Price from purchase_order_items, quantity
                // from the ledger, so the value removed stays proportional to the units removed
                // even if the decimal(10,2) line quantity and the int ledger quantity disagree.
                const unitCost = lineValue / lineQty;

                const currentAvgCost = Number(inventoryRow.avg_cost_usd);
                // Purchases are not the only thing that moves stock — this tenant also ships out
                // via DELIVER and SALE — so on-hand is routinely below what an old order supplied,
                // and can be negative outright. Clamp before it reaches the divisor.
                const currentQty = Math.max(Number(qtyRow.quantity), 0);

                const remainingQty = currentQty - supplyQty;
                const remainingValue =
                    currentQty * currentAvgCost - supplyQty * unitCost;

                // The units this purchase brought in are no longer on hand, so no pool survives to
                // carry an average. Skipping is harmless: addOrder clamps oldQty to 0 (:113), so a
                // stale average on an empty pool contributes nothing to the next blend.
                //
                // The division below happens in JS, not SQL, so neither ERROR_FOR_DIVISION_BY_ZERO
                // nor the NOT NULL constraint protects us — x/0 is Infinity, 0/0 is NaN, and
                // mysql2 sends both as the bare tokens `Infinity`/`NaN`, which MySQL rejects,
                // rolling the whole deletion back. A negative divisor is worse: accepted silently,
                // and it inverts the sign of the average.
                if (!(remainingQty > 0)) {
                    costReversal.skipped += 1;
                    continue;
                }

                // Pool is worth less than what this purchase put in, so removal would leave a
                // negative — or exactly zero — cost per unit. Zero is not neutral either:
                // addOrder:123 reads a 0.00 average as "never calculated" and reseeds it from the
                // stale unit_cost_usd on the next purchase.
                if (!(remainingValue > 0)) {
                    costReversal.skipped += 1;
                    continue;
                }

                // Round here rather than letting MySQL round on store, so the range checks below
                // are made against the value actually persisted. avg_cost_usd is decimal(10,2) and
                // the sub-cent boundary is not representable in binary floating point.
                const newAvgCost =
                    Math.round((remainingValue / remainingQty) * 100) / 100;

                // Below a cent it rounds to 0.00, which re-arms addOrder:123's reseed branch, so
                // keep the stale average instead. Upper bound is the decimal(10,2) range: strict
                // mode rounds fractional overflow but ERRORS on integer-part overflow, which would
                // abort the deletion and leave the invoice undeletable.
                if (
                    !Number.isFinite(newAvgCost) ||
                    newAvgCost < 0.01 ||
                    newAvgCost > 99999999.99
                ) {
                    costReversal.skipped += 1;
                    continue;
                }

                // KNOWN AND ACCEPTED: nothing clamps a thin remainder. When on-hand barely exceeds
                // the supplied quantity, the surviving units are revalued hard — one live line
                // leaves 4 units at 0.01 on stock invoiced at 4.73, because the stored average was
                // already carrying that distortion (14 * 3.38 = 47.32, of which the 10 removed
                // units account for 47.30). The arithmetic is an exact un-blend in every such
                // case; it surfaces existing distortion rather than creating it. Reported through
                // costReversal rather than silently clamped.
                //
                // unit_cost_usd is deliberately untouched. It means "the last cost we were told
                // about, from any source" — DeliverModel.js:65, AdminStockModel.js:187 and
                // UserHistoryModel.js:222 all write it with no provenance — so it cannot be rolled
                // back to a purchase price without guessing, and zeroing it would make
                // ReportModel.js:48 report a COGS of 0 on every future sale of the product.
                await connection.query(
                    `UPDATE inventory SET avg_cost_usd = ?
					WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                    [newAvgCost, line.product_id, line.database_id]
                );
                costReversal.adjusted += 1;
            }

            // add deleted items to inventory transactions
            // Reverse the SUPPLY rows this order actually posted instead of re-deriving
            // them from purchase_order_items. That way the reversal carries:
            //   - the same database_id as the row it cancels. The column is NOT NULL with
            //     no default, so omitting it aborts the whole deletion under strict mode,
            //     and a mismatched value would be invisible to the tenant-scoped stock
            //     queries — the supply would never be undone.
            //   - the same integer quantity that was written. purchase_order_items.quantity
            //     is decimal(10,2) while inventory_transactions.quantity is int, so the two
            //     can disagree for a fractional supply.
            // Reading and writing the same table is fine here: the SELECT matches only
            // 'SUPPLY' rows and we insert 'DELETE' rows.
            await connection.query(
                `INSERT INTO inventory_transactions (product_id_fk, database_id, transaction_type, quantity, order_id_fk, transaction_notes) SELECT product_id_fk, database_id, 'DELETE', -quantity, order_id_fk, ? FROM inventory_transactions WHERE order_id_fk = ? AND transaction_type = 'SUPPLY' AND database_id = ?`,
                [orderCheck.invoice_number, order_id, database_id]
            );

            //delete voucher and items
            let deleteVoucherQuery = `DELETE FROM journal_vouchers WHERE journal_id = ?`;
            await connection.query(
                deleteVoucherQuery,
                orderCheck.journal_voucher_id
            );

            let deleteJournalItemsQuery = `DELETE FROM journal_items WHERE journal_id_fk = ?`;
            await connection.query(
                deleteJournalItemsQuery,
                orderCheck.journal_voucher_id
            );

            // delete old items
            let deleteItemsQuery = `DELETE FROM purchase_order_items WHERE order_id_fk = ?`;
            await connection.query(deleteItemsQuery, order_id);

            // delete old invoice
            let deleteOrderQuery = `DELETE FROM purchase_orders WHERE order_id = ?`;
            await connection.query(deleteOrderQuery, order_id);

            await connection.commit();
            return costReversal;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // get added order
    static async getAddedOrderById(order_id) {
        const [order] = await pool.query(
            `SELECT * FROM purchase_orders WHERE order_id = ?`,
            [order_id]
        );
        return order;
    }
}

module.exports = PurchaseOrders;
