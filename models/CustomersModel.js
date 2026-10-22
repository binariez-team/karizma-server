const pool = require("../config/database");
const Accounts = require("./AccountsModel");
const moment = require("moment-timezone");
const { AppError } = require("../middleware/errorHandler");

// One answer for a malformed id, a missing one, another tenant's customer and one
// already deleted, so ids cannot be probed.
const CUSTOMER_NOT_FOUND = "Customer not found";

// Ids come from the URL or the request body; mysql2 expands an object bound to `?`
// into `key = value` SQL, so only a whole positive number is let through to the queries.
const toId = (value) => {
    const id =
        typeof value === "number" ||
        (typeof value === "string" && /^\d+$/.test(value))
            ? Number(value)
            : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// A balance in whole cents. mysql2 returns DECIMAL as a string ("-12.50"), so it is
// read digit by digit rather than through a float; digits past the cents (none from
// a SUM of DECIMAL(10,2)) round half away from zero, and "-0.00" is 0. Anything else
// throws, so a delete is never let through on an unreadable balance.
const toCents = (value) => {
    const text = typeof value === "number" ? String(value) : value;
    const match =
        typeof text === "string" && /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
    if (!match) throw new Error(`Unreadable balance: ${value}`);
    const [, sign, whole, fraction = ""] = match;
    const cents =
        Number(whole) * 100 +
        Number(fraction.padEnd(2, "0").slice(0, 2)) +
        (fraction.charAt(2) >= "5" ? 1 : 0);
    if (!Number.isSafeInteger(cents)) {
        throw new Error(`Unreadable balance: ${value}`);
    }
    return sign && cents ? -cents : cents;
};

// The columns the customer dialog edits. Only these are written on a create or an
// update: mysql2 writes every key of an object bound to `SET ?`, so a hand-made body
// with is_deleted, is_customer or database_id would delete a customer past the balance
// check, drop it from the Debts screen or move it to another tenant.
const EDITABLE_FIELDS = ["name", "phone", "address", "default_price"];

// Positive cents as the app's currency pipe shows them: "$1,234.50".
const formatCents = (cents) =>
    `$${String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+$)/g, ",")}.${String(
        cents % 100,
    ).padStart(2, "0")}`;

class Customer {
    // get customers debts
    static async getCustomerDebts(database_id) {
        let query = `SELECT
			a.account_id,
			a.name,
			a.phone,
			COALESCE(SUM(ji.debit) - SUM(ji.credit), 0) AS balance
		FROM
			journal_items ji
		LEFT JOIN
			journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
		INNER JOIN
			accounts a ON ji.partner_id_fk = a.account_id
		WHERE
			ji.is_deleted = 0
			AND jv.database_id = ?        
			AND a.is_customer = 1
			AND a.is_deleted = 0
		GROUP BY
			ji.partner_id_fk
		HAVING
			balance != 0
		ORDER BY
			balance DESC;`;
        const [result] = await pool.query(query, [database_id]);

        return result;
    }

    // update customer debts
    static async addManualDebt(data, database_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            data.transaction_datetime = moment(
                data.transaction_datetime
            ).format(`YYYY-MM-DD HH:mm:ss`);

            // create journal voucher
            let query = `INSERT INTO journal_vouchers (database_id, journal_date, journal_description, journal_notes, total_value) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                data.transaction_datetime,
                "Manual Transaction",
                data.transaction_notes,
                data.amount,
            ]);

            let [_4111] = await Accounts.getIdByAccountNumber("4111");
            const ordinaryClients = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: data.transaction_datetime,
                account_id_fk: _4111.id,
                partner_id_fk: data.selected_account,
                database_id: database_id,
                debit: 0,
                credit: 0,
            };

            let capitalOrCash;
            if (data.modifyCash) {
                let [_531] = await Accounts.getIdByAccountNumber("531");
                capitalOrCash = {
                    journal_id_fk: journal_voucher.insertId,
                    journal_date: data.transaction_datetime,
                    account_id_fk: _531.id,
                    reference_number: data.transaction_notes,
                    partner_id_fk: null,
                    database_id: database_id,
                    debit: 0,
                    credit: 0,
                };
            } else {
                let [_101] = await Accounts.getIdByAccountNumber("101");
                capitalOrCash = {
                    journal_id_fk: journal_voucher.insertId,
                    journal_date: data.transaction_datetime,
                    account_id_fk: _101.id,
                    reference_number: data.reference_number,
                    partner_id_fk: null,
                    database_id: database_id,
                    debit: 0,
                    credit: 0,
                };
            }

            // debit or credit based on transaction type
            if (data.transaction_type == "ADD") {
                ordinaryClients.debit = data.amount;
                capitalOrCash.credit = data.amount;
            } else {
                ordinaryClients.credit = data.amount;
                capitalOrCash.debit = data.amount;
            }

            // add journal items
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                ordinaryClients
            );
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                capitalOrCash
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    //////////////////////////////////
    //customer model related to user//
    //////////////////////////////////

    // get customers by user id
    static async getCustomersByUserId(id) {
        const [result] = await pool.query(
            "SELECT * FROM accounts WHERE database_id = ? AND is_customer = 1 AND is_deleted = 0",
            [id]
        );
        return result;
    }

    //get a customer by id and user id
    static async getCustomerByIdAndUserId(database_id, account_id) {
        const [[result]] = await pool.query(
            "SELECT * FROM accounts WHERE account_id = ? AND database_id = ? AND is_customer = 1 AND is_deleted = 0",
            [account_id, database_id]
        );
        return result;
    }

    // get customer name
    static async getCustomerNameById(account_id) {
        const [[{ name }]] = await pool.query(
            `SELECT name FROM accounts WHERE account_id = ? AND is_deleted = 0`,
            [account_id]
        );

        return name;
    }

    //create a customer related to user
    // Writes only EDITABLE_FIELDS, in the order the body sent them, then the flag and
    // the caller's tenant. The dialog also sends its empty account_id (null: the next
    // AUTO_INCREMENT id), kept so its INSERT is the same SQL as before; any other
    // account_id is dropped. Every other key is dropped too: a hand-made body could
    // create the account already deleted or flagged as a supplier, which would put it
    // on the admin's Suppliers screen and let a supplier delete remove it past the
    // customer balance check.
    static async createCustomerByUserId(database_id, data) {
        const fields = {};
        if (data && typeof data === "object") {
            for (const key of Object.keys(data)) {
                if (
                    EDITABLE_FIELDS.includes(key) ||
                    (key === "account_id" && data[key] === null)
                ) {
                    fields[key] = data[key];
                }
            }
        }
        fields.is_customer = 1;
        fields.database_id = database_id;
        const [result] = await pool.query("INSERT INTO accounts SET ?", fields);
        return result;
    }

    //update a customer related to user
    static async updateCustomerByUserId(database_id, data) {
        const id = toId(data && data.account_id);
        if (!id) throw new AppError(CUSTOMER_NOT_FOUND, 404);

        const fields = {};
        for (const field of EDITABLE_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(data, field)) {
                fields[field] = data[field];
            }
        }
        // Nothing the dialog edits was sent: no change (an empty SET is a SQL error).
        if (!Object.keys(fields).length) return null;

        const [result] = await pool.query(
            "UPDATE accounts SET ? WHERE account_id = ? AND database_id = ? AND is_customer = 1 AND is_deleted = 0",
            [fields, id, database_id]
        );
        return result;
    }

    //delete a customer related to user
    // Refused (409) while the customer's balance is not exactly zero either way: a
    // customer who still owes us, or whom we still owe, would drop off the Debts
    // screen with the money still on the books. A 404 for a malformed id, a missing
    // customer, another tenant's or one already deleted; nothing is written for any.
    static async deleteCustomerByUserId(database_id, account_id) {
        const id = toId(account_id);
        if (!id) throw new AppError(CUSTOMER_NOT_FOUND, 404);

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // Row-locked until commit, so a second delete (or an edit) of this
            // customer waits here and then sees it deleted.
            const [[customer]] = await connection.query(
                `SELECT account_id FROM accounts
                WHERE account_id = ? AND database_id = ? AND is_customer = 1 AND is_deleted = 0
                FOR UPDATE`,
                [id, database_id],
            );
            if (!customer) throw new AppError(CUSTOMER_NOT_FOUND, 404);

            // The balance the app shows (GET /:id/balance, Debts, statements). A plain
            // read, not a lock: journal_items.partner_id_fk is not indexed everywhere,
            // and a locking read would hold every row it scans, all tenants', until
            // commit. Sales and payments do not lock the customer row either, so one
            // committing right after this read can still land on a deleted customer.
            const { balance } = await Customer.getCustomerTotalBalance(
                database_id,
                id,
                connection,
            );
            const cents = toCents(balance);
            if (cents > 0) {
                throw new AppError(
                    `This customer still has a balance of ${formatCents(cents)}. Settle it before deleting.`,
                    409,
                );
            }
            if (cents < 0) {
                throw new AppError(
                    `You still owe this customer ${formatCents(-cents)}. Settle it before deleting.`,
                    409,
                );
            }

            const [result] = await connection.query(
                "UPDATE accounts SET is_deleted = 1 WHERE account_id = ? AND database_id = ? AND is_customer = 1",
                [id, database_id],
            );

            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    //get customer latest purchases
    static async getCustomerLatestPurchases(database_id, account_id) {
        const [result] = await pool.query(
            `  SELECT
            customer_id,
            product_id,
            order_id,
            order_datetime,
            unit_price,
            price_type
            FROM (
                 SELECT
                i.customer_id,
                im.product_id,
                i.order_id,
                i.order_datetime,
                im.unit_price,
                im.price_type,

                ROW_NUMBER() OVER (PARTITION BY im.product_id ORDER BY i.order_datetime DESC) AS purchase_rank
            FROM
                sales_orders i
            JOIN
                sales_order_items im ON i.order_id = im.order_id
                LEFT JOIN
                	accounts a ON a.account_id = i.customer_id
                WHERE
                    a.database_id = ?  AND i.customer_id = ? AND im.is_deleted = 0
            ) ranked_purchases
            WHERE
                purchase_rank <= 1;`,
            [database_id, account_id]
        );
        return result;
    }

    // `db` is the pool, or the connection of a transaction that needs the balance.
    static async getCustomerTotalBalance(database_id, account_id, db = pool) {
        const query = `SELECT 
					COALESCE(SUM(ji.debit) - SUM(ji.credit), 0) AS balance
				FROM 
					journal_vouchers jv
				LEFT JOIN 
					journal_items ji ON jv.journal_id = ji.journal_id_fk
				WHERE 
					ji.partner_id_fk = ?
					AND jv.database_id = ?
					AND ji.is_deleted = 0`;
        const [[result]] = await db.query(query, [account_id, database_id]);
        return result;
    }
}

module.exports = Customer;
