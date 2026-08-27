const pool = require("../config/database");
const Accounts = require("../models/AccountsModel");
const moment = require("moment-timezone");

class Expense {
    // get expense details
    static async getExpenseDetails(
        expenseNumber,
        startDate,
        endDate,
        database_id,
    ) {
        let sql = `SELECT
        jv.journal_id,
        jv.journal_number,
        jv.journal_description,
        jv.journal_date,
        jv.total_value,
        jv.journal_notes as money_account

        FROM journal_vouchers jv

		WHERE jv.database_id = ?
        AND jv.is_deleted = 0`;

        const params = [database_id];

        if (expenseNumber) {
            sql += ` AND jv.journal_number LIKE ?`;
            params.push(`%${expenseNumber}%`);
        } else {
            sql += ` AND jv.journal_number LIKE 'EXP%' `;
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
    static async updateExpense(database_id, paymentData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

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
                paymentData.journal_id,
                database_id,
            ]);

            let [moneyAccount] = await Accounts.getIdByAccountNumber(
                paymentData.money_account,
            );
            let [otherAccount] = await Accounts.getIdByAccountNumber("6112");

            await connection.query(
                `UPDATE journal_items SET credit = ?, account_id_fk = ? WHERE journal_id_fk = ? AND account_id_fk != ?`,
                [
                    paymentData.total_value,
                    moneyAccount.id,
                    paymentData.journal_id,
                    otherAccount.id,
                ],
            );

            await connection.query(
                `UPDATE journal_items SET debit = ? WHERE journal_id_fk = ? AND account_id_fk = ?`,
                [
                    paymentData.total_value,
                    paymentData.journal_id,
                    otherAccount.id,
                ],
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // delete expense
    static async deleteExpense(database_id, journal_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // Prove the voucher exists and belongs to this tenant before deleting
            // anything, and report the outcome so the caller can distinguish a real
            // delete from a no-op. Both statements below are tenant-scoped, so a
            // cross-tenant id would silently remove nothing and still look successful.
            // `journal_number LIKE 'EXP%'` is the guard that keeps this endpoint to
            // expenses. Vouchers share one table and one id space, so without it a
            // DELETE /expense/:journal_id would happily hard-delete an invoice, payment
            // or transfer voucher and every journal item under it — and the list query
            // above only applies the EXP filter when no search term is supplied, so a
            // non-expense voucher can genuinely reach this screen.
            const [[voucher]] = await connection.query(
                `SELECT journal_id FROM journal_vouchers
                WHERE journal_id = ? AND database_id = ?
                  AND journal_number LIKE 'EXP%'`,
                [journal_id, database_id],
            );
            if (!voucher) {
                await connection.rollback();
                return { deleted: 0 };
            }

            await connection.query(
                `DELETE FROM journal_items WHERE journal_id_fk = ? AND database_id = ?`,
                [journal_id, database_id],
            );

            await connection.query(
                `DELETE FROM journal_vouchers WHERE journal_id = ? AND database_id = ?`,
                [journal_id, database_id],
            );

            await connection.commit();
            return { deleted: 1, journal_id: Number(journal_id) };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = Expense;
