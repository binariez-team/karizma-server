const pool = require("../config/database");
const moment = require("moment-timezone");
const Accounts = require("./AccountsModel");
const { AppError } = require("../middleware/errorHandler");

// One answer for a malformed id, a missing one, an account that is not a supplier and
// a supplier already deleted, so ids cannot be probed.
const SUPPLIER_NOT_FOUND = "Supplier not found";

// Ids come from the URL or the request body; mysql2 expands an object bound to `?`
// into `key = value` SQL, so only a whole positive number is let through to the queries.
// (Same rule as CustomersModel.)
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
// (Same rule as CustomersModel.)
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

// Positive cents as the app's currency pipe shows them: "$1,234.50".
const formatCents = (cents) =>
    `$${String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+$)/g, ",")}.${String(
        cents % 100,
    ).padStart(2, "0")}`;

// The columns the supplier dialog edits. Only these are written on a create or an
// update: mysql2 writes every key of an object bound to `SET ?`, so a hand-made body
// with is_deleted, is_supplier, is_customer or database_id would delete a supplier past
// the balance check, drop it from the Suppliers screen or put it on a shop's
// customer list. (account_id is handled on its own in createSupplier/updateSupplier.)
const EDITABLE_FIELDS = ["name", "phone", "address"];

class Supplier {
    // get suppliers
    static async getAllSuppliers() {
        const [result] = await pool.query(
            "SELECT * FROM accounts WHERE is_supplier = 1 AND is_deleted = 0",
        );
        return result;
    }

    // get supplier by id
    static async getSupplierById(id) {
        const [[result]] = await pool.query(
            "SELECT * FROM accounts WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0",
            [id],
        );
        return result;
    }

    // create supplier
    // Writes only EDITABLE_FIELDS, in the order the body sent them, then the flag. The
    // dialog also sends its empty account_id (null: the next AUTO_INCREMENT id), kept so
    // its INSERT is the same SQL as before; any other account_id is dropped, and so is
    // every other key (is_deleted, is_customer, database_id, ...), as on an update.
    static async createSupplier(data) {
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
        fields.is_supplier = 1;
        const [result] = await pool.query("INSERT INTO accounts SET ?", fields);
        return result;
    }

    // update supplier
    // Writes only EDITABLE_FIELDS, in the order the body sent them. The dialog also
    // sends the supplier's own account_id, which has always been written back as a
    // no-op; it is kept only when it is this supplier's id (another id would move the
    // account off its journal lines), so the dialog's UPDATE is the same SQL as before.
    static async updateSupplier(id, data) {
        const supplierId = toId(id);
        if (!supplierId) throw new AppError(SUPPLIER_NOT_FOUND, 404);

        const keys =
            data && typeof data === "object"
                ? Object.keys(data).filter(
                      (key) =>
                          EDITABLE_FIELDS.includes(key) ||
                          (key === "account_id" &&
                              toId(data[key]) === supplierId),
                  )
                : [];
        // Nothing the dialog edits was sent: no change (an empty SET is a SQL error).
        if (!keys.some((key) => key !== "account_id")) return null;

        const fields = {};
        for (const key of keys) fields[key] = data[key];

        // The id is bound as its digits, as the URL's id always was.
        const [result] = await pool.query(
            "UPDATE accounts SET ? WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0",
            [fields, String(supplierId)],
        );
        return result;
    }

    // delete supplier
    // Refused (409) while the supplier's balance is not exactly zero either way: a
    // supplier we still owe, or one holding money we paid ahead, would drop off the
    // Suppliers screen and out of the reports' payables/advances (S10) with the money
    // still on the books. Also refused (409) while its lines in any other shop's books
    // do not net to zero there. A 404 for a malformed id, a missing account, one that
    // is not a supplier or a supplier already deleted; nothing is written for any.
    static async deleteSupplier(id, database_id) {
        const supplierId = toId(id);
        if (!supplierId) throw new AppError(SUPPLIER_NOT_FOUND, 404);

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // Row-locked until commit, so a second delete (or an edit) of this
            // supplier waits here and then sees it deleted.
            const [[supplier]] = await connection.query(
                `SELECT account_id FROM accounts
                WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0
                FOR UPDATE`,
                [supplierId],
            );
            if (!supplier) throw new AppError(SUPPLIER_NOT_FOUND, 404);

            // The balance the app shows (GET /:id/balance, the purchase screen, Correct
            // Debt). A plain read, not a lock: a locking read would hold every journal
            // line it scans until commit. Purchases and payments do not lock the
            // supplier row either, so one committing right after this read can still
            // land on a deleted supplier.
            const { balance } = await Supplier.getSupplierTotalBalance(
                supplierId,
                database_id,
                connection,
            );
            const cents = toCents(balance);
            if (cents > 0) {
                throw new AppError(
                    `You still owe this supplier ${formatCents(cents)}. Settle it before deleting.`,
                    409,
                );
            }
            if (cents < 0) {
                throw new AppError(
                    `This supplier still owes you ${formatCents(-cents)}. Settle it before deleting.`,
                    409,
                );
            }

            // Lines in another shop's books (a shop's Correct Debt, or an account that
            // is also a shop's customer) are not in the balance above, but the reports
            // count them in that shop's balance sheet and would drop them with the
            // supplier (S10), so they block the delete too.
            const others = await Supplier.getSupplierOtherShopBalances(
                supplierId,
                database_id,
                connection,
            );
            const open = others
                .map((row) => Math.abs(toCents(row.balance)))
                .filter((abs) => abs > 0);
            if (open.length) {
                throw new AppError(
                    `This supplier still has an open balance of ${formatCents(
                        open.reduce((sum, abs) => sum + abs, 0),
                    )} in ${open.length === 1 ? "another shop's" : "other shops'"} books. Settle it before deleting.`,
                    409,
                );
            }

            const [result] = await connection.query(
                "UPDATE accounts SET is_deleted = 1 WHERE account_id = ? AND is_supplier = 1",
                [supplierId],
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

    //get supplier total balance
    // `db` is the pool, or the connection of a transaction that needs the balance.
    static async getSupplierTotalBalance(id, database_id, db = pool) {
        const [[result]] = await db.query(
            `SELECT
		COALESCE(SUM(ji.credit) - SUM(ji.debit), 0) AS balance
		FROM journal_vouchers jv
		LEFT JOIN
		journal_items ji ON jv.journal_id = ji.journal_id_fk
		WHERE
		ji.partner_id_fk = ?
		AND ji.database_id = ?
		AND ji.is_deleted = 0`,
            [id, database_id],
        );
        return result;
    }

    // The supplier's balance in each shop other than `database_id`, as the reports count
    // it (M22 in reports-v2/metrics.js: credit − debit per journal_items.database_id,
    // only ji.is_deleted filtered). One row per shop with lines; DECIMAL strings.
    static async getSupplierOtherShopBalances(id, database_id, db = pool) {
        const [rows] = await db.query(
            `SELECT ji.database_id, ROUND(SUM(ji.credit - ji.debit), 2) AS balance
		FROM journal_items ji
		WHERE ji.partner_id_fk = ?
		AND ji.database_id <> ?
		AND ji.is_deleted = 0
		GROUP BY ji.database_id`,
            [id, database_id],
        );
        return rows;
    }

    // add manual supplier debts
    static async addManualDebt(database_id, data) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            data.transaction_datetime = moment(
                data.transaction_datetime,
            ).format(`YYYY-MM-DD HH:mm:ss`);

            // create journal voucher
            let query = `INSERT INTO journal_vouchers (journal_date, journal_description, journal_notes, total_value, database_id) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                data.transaction_datetime,
                "Manual Transaction",
                data.transaction_notes,
                data.amount,
                database_id,
            ]);

            let [_4011] = await Accounts.getIdByAccountNumber("4011");
            const invoicesAccount = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: data.transaction_datetime,
                account_id_fk: _4011.id,
                partner_id_fk: data.selected_account,
                debit: 0,
                credit: 0,
                database_id: database_id,
            };

            let [_101] = await Accounts.getIdByAccountNumber("101");
            const capitalAccount = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: data.transaction_datetime,
                account_id_fk: _101.id,
                debit: 0,
                credit: 0,
                database_id: database_id,
            };

            // debit or credit based on transaction type
            if (data.transaction_type == "ADD") {
                invoicesAccount.credit = data.amount;
                capitalAccount.debit = data.amount;
            } else {
                invoicesAccount.debit = data.amount;
                capitalAccount.credit = data.amount;
            }

            // add journal items
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                invoicesAccount,
            );
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                capitalAccount,
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

module.exports = Supplier;
