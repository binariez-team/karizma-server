const pool = require("../config/database");
const Accounts = require("./AccountsModel");
const moment = require("moment-timezone");

class Payment {
    // journal_description of the vouchers this model creates and may edit/delete
    static CUSTOMER_PAYMENT = "Payment Received";
    static SUPPLIER_PAYMENT = "Supplier Payment";

    // The journal_number prefix every creator of each kind stamps: 'Payment Received'
    // is only created as PAY#### (here and SellOrdersModel.addOrder), 'Supplier
    // Payment' only as REC#### (here and PurchaseModel). Free-text vouchers can carry
    // any description (expenses are EXP####, balance corrections 'Manual
    // Transaction'), so the description alone does not prove a voucher is a payment.
    static NUMBER_PREFIX = {
        [Payment.CUSTOMER_PAYMENT]: "PAY",
        [Payment.SUPPLIER_PAYMENT]: "REC",
    };

    // Vouchers share one table and one id space with invoices, returns, transfers,
    // initial balances and manual debt corrections, so an id alone must never be
    // enough to rewrite or delete one. Returns the voucher (row-locked for the rest
    // of the transaction) only when it is a live voucher of this tenant with one of
    // the allowed descriptions and that kind's number prefix; undefined for anything
    // else, so a caller cannot tell a missing id from another tenant's or another
    // kind of voucher.
    static async lockPaymentVoucher(
        connection,
        database_id,
        journal_id,
        descriptions,
    ) {
        const [[voucher]] = await connection.query(
            `SELECT journal_id, journal_description, journal_number FROM journal_vouchers
            WHERE journal_id = ? AND database_id = ? AND is_deleted = 0
              AND journal_description IN (?)
            FOR UPDATE`,
            [journal_id, database_id, descriptions],
        );
        // Checked here, on the stored values: the IN above cannot pair each description
        // with its own prefix, and it compares through the column's case-, accent- and
        // trailing-space-insensitive collation, while this lookup is exact.
        const prefix =
            voucher && Payment.NUMBER_PREFIX[voucher.journal_description];
        if (!prefix || !String(voucher.journal_number ?? "").startsWith(prefix)) {
            return undefined;
        }
        return voucher;
    }

    // create payment
    static async addCustomerPayment(database_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // account_id becomes the voucher's partner and fetchPaymentById echoes
            // that account's name, phone and address back, so it must be one of this
            // tenant's customers — the same set GET /customers offers the dialog.
            const [[customer]] = await connection.query(
                `SELECT account_id, name FROM accounts
                WHERE account_id = ? AND database_id = ? AND is_customer = 1 AND is_deleted = 0`,
                [paymentData.account_id, database_id],
            );
            if (!customer) {
                await connection.rollback();
                return null;
            }

            moment.tz.setDefault("Asia/Beirut");
            paymentData.payment_date = moment(paymentData.payment_date).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );

            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'PAY%'`,
            );

            let payment_number = `PAY${number.toString().padStart(4, "0")}`;

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers ( database_id, journal_number, journal_date, journal_description, journal_notes, total_value) VALUES (?, ?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                payment_number,
                paymentData.payment_date,
                "Payment Received",
                paymentData.money_account,
                paymentData.amount,
            ]);

            let [moneyAccount] = await Accounts.getIdByAccountNumber(
                paymentData.money_account,
            );
            const customer_name = customer.name;

            const firstItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: paymentData.payment_date,
                account_id_fk: moneyAccount.id,
                reference_number: paymentData.reference_number,
                partner_id_fk: null,
                debit: paymentData.amount,
                credit: 0,
                notes: customer_name,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                firstItem,
            );

            let [_413] = await Accounts.getIdByAccountNumber("413");
            const secondItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: paymentData.payment_date,
                account_id_fk: _413.id,
                reference_number: paymentData.reference_number,
                partner_id_fk: customer.account_id,
                debit: 0,
                credit: paymentData.amount,
            };
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                secondItem,
            );

            await connection.commit();
            return journal_voucher.insertId;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // edit payment
    // Returns false (nothing written) when journal_id is not one of this tenant's
    // live customer payments.
    static async editCustomerPayment(database_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const voucher = await Payment.lockPaymentVoucher(
                connection,
                database_id,
                paymentData.journal_id,
                [Payment.CUSTOMER_PAYMENT],
            );
            if (!voucher) {
                await connection.rollback();
                return false;
            }
            const { journal_id } = voucher;

            moment.tz.setDefault("Asia/Beirut");
            paymentData.payment_date = moment(paymentData.payment_date).format(
                `YYYY-MM-DD ${moment().format("HH:mm:ss")}`,
            );

            //insert to vouchers and journal_items
            let query = `UPDATE journal_vouchers SET total_value = ?, journal_notes = ? WHERE journal_id = ? and database_id = ?`;
            await connection.query(query, [
                paymentData.amount,
                paymentData.money_account,
                journal_id,
                database_id,
            ]);

            const [moneyAccount] = await Accounts.getIdByAccountNumber(
                paymentData.money_account,
            );

            const [_413] = await Accounts.getIdByAccountNumber("413");

            // Items are reached through their voucher's tenant, not by journal_id_fk
            // alone (journal_items.database_id is nullable, so it is not relied on).
            await connection.query(
                `UPDATE journal_items ji
                INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                SET ji.debit = ?, ji.journal_date = ?, ji.account_id_fk = ?
                WHERE ji.journal_id_fk = ? AND jv.database_id = ? AND ji.account_id_fk != ?`,
                [
                    paymentData.amount,
                    paymentData.payment_date,
                    moneyAccount.id,
                    journal_id,
                    database_id,
                    _413.id,
                ],
            );

            await connection.query(
                `UPDATE journal_items ji
                INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                SET ji.credit = ?, ji.journal_date = ?
                WHERE ji.journal_id_fk = ? AND jv.database_id = ? AND ji.account_id_fk = ?`,
                [
                    paymentData.amount,
                    paymentData.payment_date,
                    journal_id,
                    database_id,
                    _413.id,
                ],
            );

            await connection.commit();
            return true;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // Soft-deletes a payment voucher and its items. `descriptions` is the set of
    // payment kinds the caller may delete (the controller decides by role); returns
    // false (nothing written) for any other voucher.
    static async deletePayment(database_id, journal_id, descriptions) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const voucher = await Payment.lockPaymentVoucher(
                connection,
                database_id,
                journal_id,
                descriptions,
            );
            if (!voucher) {
                await connection.rollback();
                return false;
            }

            // journal_id_fk has no index, so a locking UPDATE filtered on it would scan
            // and lock every journal_items row until commit (blocking all tenants'
            // inserts). Read the ids first (non-locking) and update by primary key.
            const [items] = await connection.query(
                `SELECT ji.journal_item_id FROM journal_items ji
                INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                WHERE ji.journal_id_fk = ? AND jv.database_id = ?`,
                [voucher.journal_id, database_id],
            );
            if (items.length) {
                await connection.query(
                    `UPDATE journal_items ji
                    INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                    SET ji.is_deleted = 1
                    WHERE ji.journal_item_id IN (?) AND ji.journal_id_fk = ? AND jv.database_id = ?`,
                    [
                        items.map((item) => item.journal_item_id),
                        voucher.journal_id,
                        database_id,
                    ],
                );
            }

            await connection.query(
                `UPDATE journal_vouchers SET is_deleted = 1 WHERE journal_id = ? AND database_id = ?`,
                [voucher.journal_id, database_id],
            );

            await connection.commit();
            return true;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // fetch payment by ID
    static async fetchPaymentById(database_id, id) {
        const query = `SELECT
				A.name AS customer_name,
				A.phone AS customer_phone,
				A.address AS customer_address,
				A.account_id AS account_id,
				A.account_id AS customer_id,
                A.account_id AS partner_id,
				JV.*,
                JV.total_value as amount,
				JV.journal_date AS payment_date,
                JV.journal_notes AS money_account
                FROM journal_vouchers JV
                INNER JOIN journal_items I ON JV.journal_id = I.journal_id_fk
                INNER JOIN accounts A ON I.partner_id_fk = A.account_id
                WHERE JV.is_deleted = 0 AND JV.journal_id = ? AND JV.database_id = ?`;

        const [[result]] = await pool.query(query, [id, database_id]);
        return result;
    }

    // Returns false (nothing written) when account_id is not a live supplier.
    static async addSupplierPayment(database_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // Suppliers are not per-tenant (the /suppliers list ignores database_id),
            // so ownership cannot be checked; but the partner must at least be a live
            // supplier, not e.g. some tenant's customer whose balance this would move.
            const [[supplier]] = await connection.query(
                `SELECT account_id FROM accounts
                WHERE account_id = ? AND is_supplier = 1 AND is_deleted = 0`,
                [paymentData.account_id],
            );
            if (!supplier) {
                await connection.rollback();
                return false;
            }

            moment.tz.setDefault("Asia/Beirut");
            paymentData.payment_date = moment(paymentData.payment_date).format(
                `YYYY-MM-DD HH:mm:ss`,
            );

            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'REC%'`,
            );

            let payment_number = `REC${number.toString().padStart(4, "0")}`;

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers (database_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                payment_number,
                paymentData.payment_date,
                "Supplier Payment",
                paymentData.amount,
            ]);

            let [_531] = await Accounts.getIdByAccountNumber("531");

            const firstItem = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: paymentData.payment_date,
                account_id_fk: _531.id,
                reference_number: paymentData.reference_number,
                debit: 0,
                credit: paymentData.amount,
                database_id: database_id,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                firstItem,
            );

            let [_401] = await Accounts.getIdByAccountNumber("401");
            const secondItem = {
                journal_id_fk: journal_voucher.insertId,
                journal_date: paymentData.payment_date,
                account_id_fk: _401.id,
                reference_number: paymentData.reference_number,
                partner_id_fk: supplier.account_id,
                debit: paymentData.amount,
                credit: 0,
                database_id: database_id,
            };
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                secondItem,
            );

            await connection.commit();
            return true;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // edit payment
    // Returns false (nothing written) when journal_id is not one of this tenant's
    // live supplier payments.
    static async editSupplierPayment(database_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const voucher = await Payment.lockPaymentVoucher(
                connection,
                database_id,
                paymentData.journal_id,
                [Payment.SUPPLIER_PAYMENT],
            );
            if (!voucher) {
                await connection.rollback();
                return false;
            }
            const { journal_id } = voucher;

            moment.tz.setDefault("Asia/Beirut");
            paymentData.payment_date = moment(paymentData.payment_date).format(
                `YYYY-MM-DD HH:mm:ss`,
            );

            //insert to vouchers and journal_items
            let query = `UPDATE journal_vouchers SET total_value = ? WHERE journal_id = ? AND database_id = ?`;
            const [journal_voucher] = await connection.query(query, [
                paymentData.amount,
                journal_id,
                database_id,
            ]);

            let [_531] = await Accounts.getIdByAccountNumber("531");

            // Items are reached through their voucher's tenant, not by journal_id_fk
            // alone (journal_items.database_id is nullable, so it is not relied on).
            await connection.query(
                `UPDATE journal_items ji
                INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                SET ji.credit = ?, ji.journal_date = ?
                WHERE ji.journal_id_fk = ? AND jv.database_id = ? AND ji.account_id_fk = ?`,
                [
                    paymentData.amount,
                    paymentData.payment_date,
                    journal_id,
                    database_id,
                    _531.id,
                ],
            );

            let [_401] = await Accounts.getIdByAccountNumber("401");

            await connection.query(
                `UPDATE journal_items ji
                INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                SET ji.debit = ?, ji.journal_date = ?
                WHERE ji.journal_id_fk = ? AND jv.database_id = ? AND ji.account_id_fk = ?`,
                [
                    paymentData.amount,
                    paymentData.payment_date,
                    journal_id,
                    database_id,
                    _401.id,
                ],
            );

            await connection.commit();
            return true;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}
module.exports = Payment;
