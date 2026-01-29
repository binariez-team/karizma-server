const pool = require("../config/database");
const moment = require("moment-timezone");
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
                `SELECT * FROM dispose_products WHERE dispose_id = ? AND database_id = ?`,
                [dispose_id, database_id],
            );
            if (!orderCheck) throw new Error("Dispose Order not found");

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
                product.unit_cost,
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
