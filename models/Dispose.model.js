const pool = require("../config/database");
const moment = require("moment-timezone");
const InventoryCosting = require("./InventoryCosting");
moment.tz.setDefault("Asia/Beirut");

class Dispose {
    // create dispose
    static async create(database_id, info, products) {
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            // based on server time
            info.dispose_datetime = moment().format(`YYYY-MM-DD HH:mm:ss`);

            // attach database_id
            info.database_id = database_id;

            // generate dispose number
            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM dispose_products`,
            );

            // attach dispose number
            info.invoice_number = `DIS${number.toString().padStart(4, "0")}`;

            // insert created dispose
            const [result] = await connection.query(
                `INSERT INTO dispose_products SET ?`,
                info,
            );

            // dispose items
            let dispose_items = products.map((product) => [
                result.insertId,
                product.product_id,
                product.quantity,
                product.unit_cost,
            ]);

            // insert dispose items
            await connection.query(
                `INSERT INTO dispose_products_items ( dispose_id, product_id, quantity, unit_cost ) VALUES ?`,
                [dispose_items],
            );

            // insert to inventory transactions
            const query = `INSERT INTO inventory_transactions (database_id, product_id_fk, transaction_type, transaction_datetime, quantity, order_id_fk)
			VALUES ?;`;
            const values = products.map((product) => [
                database_id,
                product.product_id,
                "DISPOSE",
                info.dispose_datetime,
                -product.quantity,
                result.insertId,
            ]);

            await connection.query(query, [values]);

            // commit
            await connection.commit();

            // return created dispose_id
            return result.insertId;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // update dispose
    static async update(database_id, info, products) {
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            const { dispose_id } = info;

            console.log(info);

            // based on server time
            // info.dispose_datetime = moment().format(`YYYY-MM-DD HH:mm:ss`);

            //check existing order for user
            let [[orderCheck]] = await connection.query(
                // is_deleted = 0 is what stops a double restore. /user-stock/dispose
                // SOFT-deletes (UserStockModel.deleteDispose flags the header and items)
                // while this route HARD-deletes, so without the filter a dispose already
                // written back by one route is still visible to the other — and
                // restoreDisposedValue would put its value back a second time, with no
                // quantity movement to match.
                `SELECT * FROM dispose_products
				WHERE dispose_id = ? AND database_id = ? AND is_deleted = 0`,
                [dispose_id, database_id],
            );
            if (!orderCheck) throw new Error("Dispose Order not found");

            // Put the ORIGINAL lines' value back before their quantity returns, at the
            // cost the dispose was booked at. Deleting the DISPOSE rows below returns the
            // units but not their value, so without this the pool regains stock valued at
            // today's average instead of what was written off — 51% of live dispose lines
            // already sit on a moved average. The replacement lines below are a fresh
            // outflow and correctly leave the average alone.
            const [oldLines] = await connection.query(
                // is_deleted = 0: a soft-deleted line has already been written back
                // and must not be restored a second time.
                `SELECT product_id, quantity, unit_cost
				FROM dispose_products_items WHERE dispose_id = ? AND is_deleted = 0`,
                [dispose_id],
            );
            await InventoryCosting.restoreDisposedValue(
                connection,
                database_id,
                oldLines,
            );

            // delete inventory records
            await connection.query(
                `DELETE FROM inventory_transactions WHERE order_id_fk = ? AND database_id = ? AND transaction_type = 'DISPOSE'`,
                [dispose_id, database_id],
            );

            //add order_items to inventory transactions
            let inventoryQueries = "";
            let product_id = null;
            let quantity = null;
            products.forEach((element) => {
                product_id = element.product_id;
                quantity = element.quantity;
                // update inventory
                inventoryQueries += `INSERT INTO inventory_transactions (product_id_fk, database_id, transaction_type, transaction_datetime, quantity, order_id_fk, transaction_notes) VALUES (${product_id}, ${database_id}, 'DISPOSE', '${
                    info.dispose_datetime
                }', ${-quantity}, ${dispose_id}, '${
                    orderCheck.invoice_number
                }');`;
            });
            await connection.query(inventoryQueries);

            // delete old items
            await connection.query(
                `DELETE FROM dispose_products_items WHERE dispose_id = ?`,
                dispose_id,
            );

            // delete old dispose
            await connection.query(
                `DELETE FROM dispose_products WHERE dispose_id = ?`,
                dispose_id,
            );

            // add new dispose
            // based on server time
            // info.dispose_datetime = moment().format(`YYYY-MM-DD HH:mm:ss`);

            // attach database_id
            info.database_id = database_id;

            // attach old disponse number
            info.invoice_number = orderCheck.invoice_number;

            // Re-stamp every replacement line with the average as it stands NOW, not the
            // figure the client captured when it opened the dialog. The restore above
            // already moved the pool, so the client's number is stale: the outflow below
            // relieves value at the current average, and storing anything else would make
            // the recorded loss disagree with the value actually removed — and would make
            // a later delete restore the wrong amount. Same treatment SellOrdersModel
            // .editOrder applies to its own snapshots.
            const currentAvg = await InventoryCosting.currentAverages(
                connection,
                database_id,
                products.map((p) => p.product_id),
            );
            const costOf = (product) => {
                const server = currentAvg.get(product.product_id) || 0;
                return server > 0 ? server : product.unit_cost;
            };

            // The header total drives the loss report (ReportModel.getDisposes), so it has
            // to be rebuilt from the same costs, or the report and the lines disagree.
            info.total_cost = products.reduce(
                (sum, product) =>
                    sum + (Number(product.quantity) || 0) * Number(costOf(product)),
                0,
            );

            // insert created dispose
            const [result] = await connection.query(
                `INSERT INTO dispose_products SET ?`,
                info,
            );

            // dispose items
            let dispose_items = products.map((product) => [
                dispose_id,
                product.product_id,
                product.quantity,
                costOf(product),
            ]);

            // insert dispose items
            await connection.query(
                `INSERT INTO dispose_products_items ( dispose_id, product_id, quantity, unit_cost ) VALUES ?`,
                [dispose_items],
            );

            // commit
            await connection.commit();

            // return created dispose_id
            return result.insertId;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // delete dispose
    static async delete(database_id, dispose_id) {
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            // Prove the dispose belongs to this tenant before touching anything. The
            // header delete below is tenant-scoped but the item delete is not, so without
            // this a cross-tenant call would leave another tenant's dispose items and
            // ledger rows in an inconsistent state — and would restore value into the
            // wrong pool.
            const [[orderCheck]] = await connection.query(
                // is_deleted = 0 — see the note in update(). The two dispose routes
                // disagree on soft vs hard delete, so an already-written-back dispose
                // must not be restorable again through this one.
                `SELECT dispose_id FROM dispose_products
				WHERE dispose_id = ? AND database_id = ? AND is_deleted = 0`,
                [dispose_id, database_id],
            );
            if (!orderCheck) throw new Error("Dispose Order not found");

            // Put the written-off value back at the cost it was written off at, before
            // the DISPOSE rows are removed below and return the quantity. Restoring at
            // today's average instead would leak the drift since the dispose was made.
            const [oldLines] = await connection.query(
                // is_deleted = 0: a soft-deleted line has already been written back
                // and must not be restored a second time.
                `SELECT product_id, quantity, unit_cost
				FROM dispose_products_items WHERE dispose_id = ? AND is_deleted = 0`,
                [dispose_id],
            );
            await InventoryCosting.restoreDisposedValue(
                connection,
                database_id,
                oldLines,
            );

            // delete dispose
            await connection.query(
                `DELETE FROM dispose_products WHERE dispose_id = ? AND database_id = ?`,
                [dispose_id, database_id],
            );

            // delete dispose items
            await connection.query(
                `DELETE FROM dispose_products_items WHERE dispose_id = ?`,
                [dispose_id],
            );

            // delete inventory transactions
            await connection.query(
                `DELETE FROM inventory_transactions WHERE order_id_fk = ? AND database_id = ? AND transaction_type = 'DISPOSE'`,
                [dispose_id, database_id],
            );

            // commit
            await connection.commit();

            // return dispose_id
            return dispose_id;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = Dispose;
