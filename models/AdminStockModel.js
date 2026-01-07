const pool = require("../config/database");

class Product {
    // get all products
    static async getAll(user) {
        let id = user.database_id;

        const query = `SELECT
					C.category_name,
					B.brand_name,
					P.product_id,
					P.product_name,
					P.sku,
					P.category_id_fk,
					P.brand_id_fk,
                    I.unit_cost_usd,
                    I.avg_cost_usd,
					I.grandwhole_price_usd,
					I.whole_price_usd,
					I.unit_price_usd,
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
					GROUP BY product_id_fk
				) t ON P.product_id = t.product_id_fk
				WHERE P.is_deleted = 0
				ORDER BY P.product_id ASC;`;

        const [result] = await pool.query(query, [id, id]);
        return result;
    }

    // get by product_id
    static async getById(product_id, database_id) {
        const query = `SELECT
					C.category_name,
					B.brand_name,
					P.product_id,
					P.product_name,
					P.sku,
					
					P.category_id_fk,
					P.brand_id_fk,
                    I.unit_cost_usd,
                    I.avg_cost_usd,
					I.grandwhole_price_usd,
					I.whole_price_usd,
					I.unit_price_usd,
					COALESCE(t.quantity, 0) AS quantity
				FROM products P
				INNER JOIN inventory I ON P.product_id = I.product_id_fk  AND I.database_id = ?
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
					GROUP BY product_id_fk
				) t ON P.product_id = t.product_id_fk
				WHERE P.product_id = ?`;

        const [rows] = await pool.query(query, [
            database_id,
            database_id,
            product_id,
        ]);
        return rows;
    }

    // create new product
    static async create(data, user) {
        const connection = await pool.getConnection();
        try {
            // begin transaction
            await connection.beginTransaction();

            let product = {
                category_id_fk: data.category_id_fk,
                sku: data.sku,
                brand_id_fk: data.brand_id_fk,
                product_name: data.product_name,
                // unit_cost_usd: data.unit_cost_usd,
                // avg_cost_usd: data.unit_cost_usd,
                product_notes: data.product_notes,
            };
            // // insert into product table
            const [rows] = await connection.query(
                `INSERT INTO products SET ?`,
                product
            );

            if (data.quantity) {
                await connection.query(
                    `INSERT INTO inventory_transactions (product_id_fk, quantity, database_id, transaction_type, transaction_notes) VALUES (?, ?, ?, 'ADD', 'Initial Quantity');`,
                    [rows.insertId, data.quantity, user.database_id]
                );
            }

            let inventory = {
                product_id_fk: rows.insertId,
                database_id: user.database_id,
                unit_cost_usd: data.unit_cost_usd,
                avg_cost_usd: data.unit_cost_usd,
                grandwhole_price_usd: data.grandwhole_price_usd,
                whole_price_usd: data.whole_price_usd,
                unit_price_usd: data.unit_price_usd,
            };
            await connection.query(`INSERT INTO inventory SET ?`, inventory);

            // // commit transaction
            await connection.commit();

            return rows;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // update existing product
    static async update(data, user) {
        const connection = await pool.getConnection();
        try {
            // begin transaction
            await connection.beginTransaction();

            let product = {
                category_id_fk: data.category_id_fk,
                sku: data.sku,
                brand_id_fk: data.brand_id_fk,
                product_name: data.product_name,
                // unit_cost_usd: data.unit_cost_usd,
                product_notes: data.product_notes,
            };

            // update product table
            await connection.query(
                `UPDATE products SET ? WHERE product_id = ?`,
                [product, data.product_id]
            );

            // update inventory
            let inventory = {
                unit_cost_usd: data.unit_cost_usd,
                grandwhole_price_usd: data.grandwhole_price_usd,
                whole_price_usd: data.whole_price_usd,
                unit_price_usd: data.unit_price_usd,
            };

            if (data.change_avg_cost) {
                inventory.avg_cost_usd = data.unit_cost_usd;
            }

            await connection.query(
                `UPDATE inventory SET ? WHERE product_id_fk = ? AND database_id = ?`,
                [inventory, data.product_id, user.database_id]
            );

            // commit transaction
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // delete product
    static async delete(id) {
        const connection = await pool.getConnection();
        try {
            // begin transaction
            await connection.beginTransaction();

            // delete from product table
            await connection.query(
                `UPDATE products SET is_deleted = 1 WHERE product_id = ?`,
                id
            );

            // delete from inventory
            await connection.query(
                `UPDATE inventory SET is_deleted = 1 WHERE product_id_fk = ?`,
                id
            );

            // commit transaction
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // update stock qty manually
    static async updateStock(data) {
        if (data.transaction_type === "REMOVE") {
            data.quantity = -data.quantity;
        }
        let query = `INSERT INTO inventory_transactions SET ?`;
        await pool.query(query, data);
    }
}

module.exports = Product;
