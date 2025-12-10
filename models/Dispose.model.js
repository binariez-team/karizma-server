const pool = require("../config/database");
const moment = require("moment-timezone");

class Dispose {
    // create dispose
    static async create(database_id, info, products) {
        const connection = await pool.getConnection();
        moment.tz.setDefault("Asia/Beirut");

        try {
            await connection.beginTransaction();

            // based on server time
            info.dispose_datetime = moment().format(`YYYY-MM-DD HH:mm:ss`);

            // attach database_id
            info.database_id = database_id;

            // generate dispose number
            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(invoice_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM dispose_products`
            );

            // attach dispose number
            info.invoice_number = `DIS${number.toString().padStart(4, "0")}`;

            // insert created dispose
            const [result] = await connection.query(
                `INSERT INTO dispose_products SET ?`,
                info
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
                [dispose_items]
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
}

module.exports = Dispose;
