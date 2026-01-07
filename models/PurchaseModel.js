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
    static async deleteOrder(order_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            //check existing order for user
            let [[orderCheck]] = await connection.query(
                `
				SELECT * FROM purchase_orders WHERE order_id = ?`,
                [order_id]
            );
            if (!orderCheck) throw new Error("Order not found");

            // add deleted items to inventory transactions
            await connection.query(
                `INSERT INTO inventory_transactions (product_id_fk, transaction_type, quantity, order_id_fk, transaction_notes) SELECT product_id_fk, 'DELETE', -quantity, order_id_fk, '${orderCheck.invoice_number}' FROM purchase_order_items WHERE order_id_fk = ?`,
                [order_id]
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
