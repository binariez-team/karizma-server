const pool = require("../config/database");
const moment = require("moment-timezone");
const InventoryCosting = require("./InventoryCosting");

class UserProduct {
    static async getAll(database_id) {
        const query = `SELECT
					C.category_name,
					B.brand_name,
					P.product_id,
					P.product_name,
					P.sku,
                    I.unit_cost_usd,
                    I.avg_cost_usd,
					I.grandwhole_price_usd,
					I.whole_price_usd,
					I.unit_price_usd,
					I.low_stock_threshold,
					I.show_on_sell_page,
					COALESCE(t.quantity, 0) AS quantity
				FROM products P
				INNER JOIN inventory I ON P.product_id = I.product_id_fk AND I.database_id = ?
				LEFT JOIN products_categories C ON P.category_id_fk = C.category_id
				LEFT JOIN products_brands B ON P.brand_id_fk = B.brand_id
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
				WHERE P.is_deleted = 0
				ORDER BY P.product_id ASC;`;

        const [result] = await pool.query(query, [database_id, database_id]);
        return result;
    }

    static async getById(database_id, product_id) {
        const query = `SELECT
					C.category_name,
					B.brand_name,
					P.product_id,
					P.product_name,
					P.sku,
					I.unit_cost_usd,
                    I.avg_cost_usd,
					I.grandwhole_price_usd,
					I.whole_price_usd,
					I.unit_price_usd,
					I.low_stock_threshold,
					I.show_on_sell_page,
					COALESCE(t.quantity, 0) AS quantity
				FROM products P
				INNER JOIN inventory I ON P.product_id = I.product_id_fk AND I.database_id = ?
				LEFT JOIN products_categories C ON P.category_id_fk = C.category_id
				LEFT JOIN products_brands B ON P.brand_id_fk = B.brand_id
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
				WHERE P.product_id = ?`;

        const [result] = await pool.query(query, [
            database_id,
            database_id,
            product_id,
        ]);
        return result;
    }

    // update
    static async update(database_id, product_id, prices) {
        const query = `UPDATE inventory
            SET grandwhole_price_usd = ?,
            whole_price_usd = ?,
            unit_price_usd = ?,
            low_stock_threshold = ?,
            show_on_sell_page = ?
            WHERE product_id_fk = ? AND database_id = ?;`;

        await pool.query(query, [
            prices.grandwhole_price_usd,
            prices.whole_price_usd,
            prices.unit_price_usd,
            prices.low_stock_threshold ?? null,
            prices.show_on_sell_page ? 1 : 0,
            product_id,
            database_id,
        ]);
    }

    // bulk update sell-page visibility for the current database_id
    static async updateVisibility(database_id, productIds, show) {
        if (!productIds || !productIds.length) return;
        await pool.query(
            `UPDATE inventory SET show_on_sell_page = ? WHERE product_id_fk IN (?) AND database_id = ?`,
            [show ? 1 : 0, productIds, database_id],
        );
    }

    // dispose
    static async dispose(database_id, info, products) {
        const connection = await pool.getConnection();
        moment.tz.setDefault("Asia/Beirut");

        try {
            await connection.beginTransaction();

            info.dispose_datetime = moment(info.dispose_datetime).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );
            info.database_id = database_id;

            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM dispose_products`,
            );

            info.invoice_number = `DIS${number.toString().padStart(4, "0")}`;

            let query = `INSERT INTO dispose_products SET ?`;

            const [result] = await connection.query(
                `INSERT INTO dispose_products SET ?`,
                info,
            );
            let dispose_items = products.map((product) => [
                result.insertId,
                product.product_id,
                product.quantity,
                product.unit_cost,
            ]);

            await connection.query(
                `INSERT INTO dispose_products_items ( dispose_id, product_id, quantity, unit_cost ) VALUES ?`,
                [dispose_items],
            );

            query = `INSERT INTO inventory_transactions (database_id, product_id_fk, transaction_type, transaction_datetime, quantity, order_id_fk)
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

            await connection.commit();
            return result.insertId;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    static async updateDispose(database_id, info, products) {
        const connection = await pool.getConnection();
        moment.tz.setDefault("Asia/Beirut");
        try {
            await connection.beginTransaction();

            //delete old dispose
            //check existing order for user
            let [[disposeCheck]] = await connection.query(
                `
				SELECT * FROM dispose_products WHERE dispose_id = ? AND database_id = ? AND is_deleted = 0`,
                [info.dispose_id, database_id],
            );
            if (!disposeCheck) throw new Error("Order not found");

            //fix datetime
            info.dispose_datetime = moment(info.dispose_datetime).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );

            // Put the ORIGINAL lines' value back at the cost they were written off at,
            // before the REVERSEDISPOSE rows return their quantity below. Restoring at
            // today's average instead would leak the drift since the dispose was made.
            // The replacement lines are a fresh outflow and correctly leave the average
            // alone.
            const [oldLines] = await connection.query(
                // is_deleted = 0: a soft-deleted line has already been written back
                // and must not be restored a second time.
                `SELECT product_id, quantity, unit_cost
				FROM dispose_products_items WHERE dispose_id = ? AND is_deleted = 0`,
                [info.dispose_id],
            );
            await InventoryCosting.restoreDisposedValue(
                connection,
                database_id,
                oldLines,
            );

            //inventory_transactions
            await connection.query(
                `INSERT INTO inventory_transactions (product_id_fk, database_id, transaction_type, quantity) SELECT product_id, ?, 'REVERSEDISPOSE', quantity FROM dispose_products_items WHERE dispose_id = ? AND is_deleted = 0`,
                [database_id, info.dispose_id],
            );

            let query = `DELETE FROM dispose_products_items WHERE dispose_id = ?;`;
            await connection.query(query, [info.dispose_id]);

            /////////////////add new dispose//////////////

            // Re-stamp every replacement line with the average as it stands NOW, not the
            // figure the client captured when it opened the dialog. The restore above
            // already moved the pool, so the client's number is stale: the outflow below
            // relieves value at the current average, and storing anything else would make
            // the recorded loss disagree with the value actually removed — and would make
            // a later delete restore the wrong amount.
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
                    sum +
                    (Number(product.quantity) || 0) * Number(costOf(product)),
                0,
            );

            query = `UPDATE dispose_products SET ? WHERE dispose_id = ?;`;
            await connection.query(query, [info, info.dispose_id]);

            let dispose_items = products.map((product) => [
                info.dispose_id,
                product.product_id,
                product.quantity,
                costOf(product),
            ]);

            await connection.query(
                `INSERT INTO dispose_products_items ( dispose_id, product_id, quantity, unit_cost ) VALUES ?`,
                [dispose_items],
            );

            // order_id_fk is required: both delete paths remove DISPOSE rows by
            // `order_id_fk = dispose_id` (UserStockModel.deleteDispose and
            // Dispose.model.delete), so a replacement row written without it can never
            // be reversed — the delete matches nothing and the stock stays out
            // permanently while the value is restored.
            query = `INSERT INTO inventory_transactions (database_id, product_id_fk, transaction_type, transaction_datetime, quantity, order_id_fk)
			VALUES ?;`;

            // DISPOSE takes stock out, so the quantity is stored negative — same as
            // addDispose above and Dispose.model.js:109. Readers sum `quantity` as
            // stored and never flip the sign, so a positive row here turns an edited
            // dispose into a stock increase of +q instead of a decrease of -q.
            const values = products.map((product) => [
                database_id,
                product.product_id,
                "DISPOSE",
                info.dispose_datetime,
                -product.quantity,
                info.dispose_id,
            ]);

            await connection.query(query, [values]);

            await connection.commit();
            return info.dispose_id;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    static async deleteDispose(database_id, dispose_id) {
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            //check existing order for user
            let [[disposeCheck]] = await connection.query(
                `
				SELECT * FROM dispose_products WHERE dispose_id = ? AND database_id = ? AND is_deleted = 0`,
                [dispose_id, database_id],
            );
            if (!disposeCheck) throw new Error("Order not found");

            // Put the written-off value back at the cost it was written off at, before
            // the DISPOSE rows are removed below and return the quantity.
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

            let query = `UPDATE dispose_products_items SET is_deleted = 1 WHERE dispose_id = ?;`;
            await connection.query(query, [dispose_id]);

            query = `UPDATE dispose_products SET is_deleted = 1 WHERE dispose_id = ?;`;
            await connection.query(query, [dispose_id]);

            // database_id keeps the delete inside this tenant — dispose_id is not
            // tenant-scoped, so without it this could remove another tenant's rows.
            await connection.query(
                `DELETE FROM inventory_transactions WHERE transaction_type = 'DISPOSE' AND order_id_fk = ? AND database_id = ?`,
                [dispose_id, database_id],
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

module.exports = UserProduct;
