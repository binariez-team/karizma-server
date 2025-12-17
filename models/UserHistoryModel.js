const pool = require("../config/database");
const moment = require("moment");

class UserHistory {
    // fetch deliver invoices for admin
    static async fetchDeliverHistory(database_id, criteria) {
        let sql = `SELECT
                O.*,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('record_id', M.record_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_price', M.unit_price)) items
            	FROM deliver_orders O
            	INNER JOIN deliver_order_items M ON O.order_id = M.order_id_fk
				INNER JOIN products S ON S.product_id = M.product_id
				WHERE O.is_deleted = 0
				AND O.is_approved = 1
				AND O.database_id = ? `;
        const params = [database_id];
        if (criteria.invoice_number) {
            sql += ` AND O.invoice_number = ?`;
            params.push(criteria.invoice_number);
        }
        if (criteria.order_date) {
            sql += ` AND DATE(order_datetime) = ?`;
            params.push(moment(criteria.order_date).format("yyyy-MM-DD"));
        }

        sql += ` GROUP BY O.order_id
        ORDER BY order_date DESC, O.invoice_number DESC
        LIMIT ? OFFSET ?`;
        params.push(criteria.limit || 100);
        params.push(criteria.offset || 0);

        const [rows] = await pool.query(sql, params);
        return rows;
    }

    // fetch pending
    static async fetchPendingInvoices(database_id) {
        let sql = `SELECT
                O.*,
                DATE(O.order_datetime) AS order_date,
                JSON_ARRAYAGG(JSON_OBJECT('record_id', M.record_id, 'product_id', M.product_id, 'product_name', S.product_name, 'quantity', M.quantity, 'unit_price', M.unit_price)) items
            	FROM deliver_orders O
            	INNER JOIN deliver_order_items M ON O.order_id = M.order_id_fk
				INNER JOIN products S ON S.product_id = M.product_id
				WHERE O.is_deleted = 0
				AND O.is_approved = 0
				AND O.database_id = ? 
				GROUP BY O.order_id
				ORDER BY order_date DESC, O.invoice_number DESC`;

        const [rows] = await pool.query(sql, [database_id]);
        return rows;
    }

    // approve pending invoice
    static async approvePendingInvoice(id, database_id, admin_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // check if the deliver order id has already been approved
            let [[check]] = await connection.query(
                `SELECT is_approved FROM deliver_orders WHERE order_id = ?`,
                [id]
            );

            if (check && check.is_approved == 1) {
                await connection.rollback();
                return { status: "error", message: "Already approved!" };
                // throw new Error("Already approved!");
            }

            await connection.query(
                `UPDATE deliver_orders SET is_approved = 1 WHERE order_id = ?`,
                id
            );

            //	********************************
            //	loop of each invoice item record
            //	********************************

            let [items] = await connection.query(
                `SELECT * FROM deliver_order_items WHERE order_id_fk = ? and is_deleted = 0`,
                id
            );
            for (const record of items) {
                // check if inventory records has previously inserted
                let [[inserted]] = await connection.query(
                    `SELECT * FROM inventory WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0;`,
                    [record.product_id, database_id]
                );

                // if records have not been inserted before
                if (!inserted) {
                    // prepare default inventory record prices (created by admin)
                    let [[rows]] = await connection.query(
                        `SELECT * FROM inventory WHERE database_id = ? AND product_id_fk = ?;`,
                        [admin_id, record.product_id]
                    );
                    let {
                        grandwhole_price_usd,
                        whole_price_usd,
                        unit_price_usd,
                    } = rows;
                    const inventoryRecord = {
                        product_id_fk: record.product_id,
                        database_id: database_id,
                        grandwhole_price_usd: grandwhole_price_usd,
                        whole_price_usd: whole_price_usd,
                        unit_price_usd: unit_price_usd,
                    };
                    // insert a new inventory record with default prices
                    await connection.query(
                        `INSERT INTO inventory SET ?`,
                        inventoryRecord
                    );
                }

                // add user record to inventory transactions
                await connection.query(
                    `INSERT INTO inventory_transactions (product_id_fk, database_id, quantity, transaction_type) VALUES (${record.product_id}, ${database_id}, ${record.quantity}, 'DELIVER');`
                );
            }

            // after successfull
            await connection.commit();

            return {
                status: "success",
                message: "Invoice approved successfully!",
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    //fetch transfer history
    static async fetchUserMoneyTransferHistory(database_id, criteria) {
        let sql = ` SELECT jv.journal_id,jv.journal_number,jv.journal_date as payment_date,jv.total_value
        FROM journal_vouchers jv
        WHERE jv.database_id = ? AND jv.journal_description = 'Transfer'
        AND jv.is_deleted = 0`;
        const params = [database_id];
        if (criteria.payment_number) {
            sql += ` AND jv.journal_number = ?`;
            params.push(criteria.payment_number);
        }
        if (criteria.payment_date) {
            sql += ` AND DATE(jv.journal_date) = ?`;
            params.push(moment(criteria.payment_date).format("yyyy-MM-DD"));
        }
        sql += ` ORDER BY payment_date DESC, jv.journal_number DESC
		LIMIT ? OFFSET ?`;
        params.push(criteria.limit || 100);
        params.push(criteria.offset || 0);

        const [transfers] = await pool.query(sql, params);
        return transfers;
    }
}

module.exports = UserHistory;
