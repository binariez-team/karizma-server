const pool = require("../config/database");
const Accounts = require("../models/AccountsModel");
const moment = require("moment-timezone");

class Expense {
    // The accounts an expense can be paid from: the expense dialog's "Source" options
    // (client MoneyAccountsService) and the money_transfers.money_account enum. The
    // number is stored in journal_notes and the money-side item is posted to it.
    static MONEY_ACCOUNTS = ["531", "532"];

    // Expenses share journal_vouchers (and its id space) with invoices, payments,
    // returns, transfers and manual debt corrections, and only createExpense numbers a
    // voucher EXP####. Returns the voucher, row-locked for the rest of the
    // transaction, only when it is a live expense of this tenant; undefined for
    // anything else, so a caller cannot tell a missing id from another tenant's,
    // deleted or non-expense voucher.
    static async lockExpenseVoucher(connection, database_id, journal_id) {
        const [[voucher]] = await connection.query(
            `SELECT journal_id FROM journal_vouchers
            WHERE journal_id = ? AND database_id = ? AND is_deleted = 0
              AND journal_number LIKE 'EXP%'
            FOR UPDATE`,
            [journal_id, database_id],
        );
        return voucher;
    }

    // A voucher's items, reached through the voucher's tenant (journal_items.database_id
    // is nullable, so it is not relied on). Deliberately non-locking: journal_id_fk has
    // no index, so a locking read or a write filtered on it would lock every
    // journal_items row it scans until commit, blocking all tenants. The voucher lock
    // already serializes the writers of this expense; callers write by primary key.
    static async getVoucherItems(connection, database_id, journal_id) {
        const [items] = await connection.query(
            `SELECT ji.journal_item_id, ji.account_id_fk FROM journal_items ji
            INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
            WHERE ji.journal_id_fk = ? AND jv.database_id = ?`,
            [journal_id, database_id],
        );
        return items;
    }

    // get expense details
    static async getExpenseDetails(
        expenseNumber,
        startDate,
        endDate,
        database_id,
    ) {
        // The EXP filter stays on whatever the search: this list hands its ids to the
        // edit/delete dialog, so a search term only narrows within expenses.
        let sql = `SELECT
        jv.journal_id,
        jv.journal_number,
        jv.journal_description,
        jv.journal_date,
        jv.total_value,
        jv.journal_notes as money_account

        FROM journal_vouchers jv

		WHERE jv.database_id = ?
        AND jv.is_deleted = 0
        AND jv.journal_number LIKE 'EXP%'`;

        const params = [database_id];

        if (expenseNumber) {
            sql += ` AND jv.journal_number LIKE ?`;
            params.push(`%${expenseNumber}%`);
        }
        if (startDate) {
            sql += ` AND DATE(jv.journal_date) >= ? `;
            params.push(startDate);
        }
        if (endDate) {
            sql += ` AND DATE(jv.journal_date) <= ? `;
            params.push(endDate);
        }

        sql += ` ORDER BY jv.journal_date DESC `;
        if (expenseNumber || startDate || endDate) {
            // do nothing now for LIMITING (no limit)
        } else {
            sql += ` LIMIT 100`;
        }

        const [expenses] = await pool.query(sql, params);
        return expenses;
    }

    // get expense accounts
    static async getExpenseAccounts() {
        const accounts = await Accounts.getAccountsByAccountNumber("6112%");
        return accounts;
    }

    // create expense
    static async createExpense(database_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            paymentData.payment_date = moment(paymentData.payment_date).format(
                `YYYY-MM-DD HH:mm:ss`,
            );

            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'EXP%'`,
            );

            let payment_number = `EXP${number.toString().padStart(4, "0")}`;

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers (journal_number, journal_date, journal_description, journal_notes, total_value, database_id) VALUES (?, ?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                payment_number,
                paymentData.payment_date,
                paymentData.journal_description,
                paymentData.money_account,
                paymentData.total_value,
                database_id,
            ]);

            let [moneyAccount] = await Accounts.getIdByAccountNumber(
                paymentData.money_account,
            );

            const cashAccount = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: paymentData.payment_date,
                account_id_fk: moneyAccount.id,
                reference_number: paymentData.reference_number,
                credit: paymentData.total_value,
            };
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                cashAccount,
            );

            let [_6112] = await Accounts.getIdByAccountNumber("6112");

            const secondItem = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: paymentData.payment_date,
                account_id_fk: _6112.id,
                reference_number: paymentData.reference_number,
                debit: paymentData.total_value,
            };
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                secondItem,
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // update expense
    // Returns false (nothing written) when journal_id is not one of this tenant's live
    // expenses.
    static async updateExpense(database_id, journal_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const voucher = await Expense.lockExpenseVoucher(
                connection,
                database_id,
                journal_id,
            );
            if (!voucher) {
                await connection.rollback();
                return false;
            }

            moment.tz.setDefault("Asia/Beirut");
            // paymentData.payment_date = moment(paymentData.payment_date).format(
            // 	`YYYY-MM-DD HH:mm:ss`
            // );

            // update journal vouchers and journal items
            let query = `UPDATE journal_vouchers SET journal_description = ?, journal_notes = ?, total_value = ? WHERE journal_id = ? AND database_id = ?`;
            await connection.query(query, [
                // paymentData.payment_date,
                paymentData.journal_description,
                paymentData.money_account,
                paymentData.total_value,
                voucher.journal_id,
                database_id,
            ]);

            let [moneyAccount] = await Accounts.getIdByAccountNumber(
                paymentData.money_account,
            );

            // The expense side is the item on an expense account (6112 or, on older
            // expenses, one of its 6112x sub-accounts); the other item is the money
            // side. Matching only 6112 itself would treat a sub-account item as the
            // money side and rewrite it into a second credit on the money account.
            const expenseAccountIds = new Set(
                (await Expense.getExpenseAccounts()).map((a) => a.id),
            );
            const items = await Expense.getVoucherItems(
                connection,
                database_id,
                voucher.journal_id,
            );
            const moneyItemIds = items
                .filter((i) => !expenseAccountIds.has(i.account_id_fk))
                .map((i) => i.journal_item_id);
            const expenseItemIds = items
                .filter((i) => expenseAccountIds.has(i.account_id_fk))
                .map((i) => i.journal_item_id);

            if (moneyItemIds.length) {
                await connection.query(
                    `UPDATE journal_items ji
                    INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                    SET ji.credit = ?, ji.account_id_fk = ?
                    WHERE ji.journal_item_id IN (?) AND ji.journal_id_fk = ? AND jv.database_id = ?`,
                    [
                        paymentData.total_value,
                        moneyAccount.id,
                        moneyItemIds,
                        voucher.journal_id,
                        database_id,
                    ],
                );
            }

            if (expenseItemIds.length) {
                await connection.query(
                    `UPDATE journal_items ji
                    INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                    SET ji.debit = ?
                    WHERE ji.journal_item_id IN (?) AND ji.journal_id_fk = ? AND jv.database_id = ?`,
                    [
                        paymentData.total_value,
                        expenseItemIds,
                        voucher.journal_id,
                        database_id,
                    ],
                );
            }

            await connection.commit();
            return true;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // delete expense (hard delete, as before)
    static async deleteExpense(database_id, journal_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // Prove the voucher is a live expense of this tenant, and lock it, before
            // deleting anything; report the outcome so the caller can distinguish a real
            // delete from a no-op. Without the EXP guard a DELETE /expense/:journal_id
            // would hard-delete an invoice, payment or transfer voucher and every item
            // under it. Soft-deleted expenses are already gone from the list and the
            // reports, so they are "not found" here too.
            const voucher = await Expense.lockExpenseVoucher(
                connection,
                database_id,
                journal_id,
            );
            if (!voucher) {
                await connection.rollback();
                return { deleted: 0 };
            }

            const items = await Expense.getVoucherItems(
                connection,
                database_id,
                voucher.journal_id,
            );
            if (items.length) {
                await connection.query(
                    `DELETE ji FROM journal_items ji
                    INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                    WHERE ji.journal_item_id IN (?) AND ji.journal_id_fk = ? AND jv.database_id = ?`,
                    [
                        items.map((i) => i.journal_item_id),
                        voucher.journal_id,
                        database_id,
                    ],
                );
            }

            await connection.query(
                `DELETE FROM journal_vouchers WHERE journal_id = ? AND database_id = ?`,
                [voucher.journal_id, database_id],
            );

            await connection.commit();
            return { deleted: 1, journal_id: voucher.journal_id };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = Expense;
