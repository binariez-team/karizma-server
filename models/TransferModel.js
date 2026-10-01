const pool = require("../config/database");
const moment = require("moment-timezone");

class Transfer {
    // The accounts a transfer can be sent from: the dialog's "Source" options (client
    // MoneyAccountsService) and the money_transfers.money_account enum.
    static MONEY_ACCOUNTS = ["531", "532"];

    // Outcomes of update / delete / confirmTransfer. Every one but OK is returned after
    // a rollback, with nothing written.
    static OK = "ok";
    static NOT_FOUND = "not_found";
    static CONFIRMED = "confirmed";
    static NO_VOUCHER = "no_voucher";

    // A transfer is shared by two tenants: the sender (from_database_id) edits and
    // deletes it, the receiver (to_database_id) confirms it. Returns the live transfer
    // only when `side` of it is the caller, row-locked for the rest of the transaction
    // so the pending check that follows cannot go stale (two concurrent confirms used
    // to both read is_approved = 0 and post the receiver's item twice); undefined for
    // anything else, so a caller cannot tell a missing id from another tenant's, a
    // deleted one or one it is on the other side of.
    static async lockTransfer(connection, transfer_id, side, database_id) {
        const [[transfer]] = await connection.query(
            `SELECT transfer_id, transfer_number, journal_id, transfer_datetime, amount,
                money_account, from_database_id, to_database_id, is_approved
            FROM money_transfers
            WHERE transfer_id = ? AND ?? = ? AND is_deleted = 0
            FOR UPDATE`,
            [transfer_id, side, database_id],
        );
        return transfer;
    }

    // money_transfers.journal_id is only trusted while it points at the transfer's own
    // voucher: the sender's TRA voucher create() wrote under the transfer's own number
    // (it stores the same TRA#### as transfer_number and journal_number). Vouchers share
    // one table and one id space with every other kind, and every transfer has a TRA
    // voucher, so without the number a bad journal_id could reach another tenant's,
    // another kind of, or another (e.g. confirmed) transfer's voucher. Row-locked like
    // the transfer.
    static async lockTransferVoucher(connection, transfer) {
        const [[voucher]] = await connection.query(
            `SELECT journal_id FROM journal_vouchers
            WHERE journal_id = ? AND database_id = ? AND journal_number LIKE 'TRA%'
              AND journal_number = ?
            FOR UPDATE`,
            [
                transfer.journal_id,
                transfer.from_database_id,
                transfer.transfer_number,
            ],
        );
        return voucher;
    }

    // Ids of the verified voucher's items, reached through the voucher's tenant (the
    // sender); with `database_id`, only the items posted for that database. Deliberately
    // non-locking: journal_id_fk has no index, so a locking read or a write filtered on
    // it would lock every journal_items row it scans until commit, blocking all tenants.
    // The transfer lock already serializes the writers of this transfer; callers write
    // by primary key.
    static async getVoucherItemIds(connection, voucher, sender, database_id) {
        let query = `SELECT ji.journal_item_id FROM journal_items ji
            INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
            WHERE ji.journal_id_fk = ? AND jv.database_id = ?`;
        const params = [voucher.journal_id, sender];
        if (database_id !== undefined) {
            query += ` AND ji.database_id = ?`;
            params.push(database_id);
        }
        const [items] = await connection.query(query, params);
        return items.map((item) => item.journal_item_id);
    }

    // chart_of_accounts id of a money account ('531' / '532'), read on the transaction's
    // connection: AccountsModel.getIdByAccountNumber uses the pool, so a request that
    // holds its connection (and its row locks) would wait for a second one, and once
    // every pool connection is held that way nothing is ever released (mysql2's pool
    // has no acquire timeout).
    static async getMoneyAccountId(connection, account_number) {
        const [[account]] = await connection.query(
            `SELECT id FROM chart_of_accounts WHERE account_number = ?`,
            [account_number],
        );
        return account.id;
    }

    // The first name item notes show for a database ("To Ali", "From Sara").
    static async getFirstName(connection, database_id) {
        const [[user]] = await connection.query(
            `SELECT first_name FROM users WHERE database_id = ?`,
            [database_id],
        );
        return user?.first_name ?? "";
    }

    // get accounts suitable for transfer
    static async getTransferAccounts(database_id) {
        const query = `SELECT 
        d.*,
        CONCAT(u.first_name, ' ', u.last_name) AS full_name
        FROM user_database d
        INNER JOIN users u ON d.database_id = u.database_id
        WHERE u.user_type != 'staff' AND u.is_deleted = 0 AND u.database_id != ?`;
        const [rows] = await pool.query(query, [database_id]);
        return rows;
    }

    // get all money transfers for a specific database_id
    static async getAll(database_id, criteria) {
        let sql = `
        SELECT 
            mt.transfer_id,
            mt.transfer_number,
            mt.transfer_datetime,
            mt.amount,
            mt.money_account,
            mt.from_database_id,
            mt.to_database_id,
            mt.is_approved,

            -- Names
            db_from.database_name AS from_database_name,
            db_to.database_name   AS to_database_name,

            -- Direction
            CASE 
                WHEN mt.from_database_id = ? THEN 'sent'
                ELSE 'received'
            END AS direction,

            -- Other party (very useful)
            CASE 
                WHEN mt.from_database_id = ? THEN db_to.database_name
                ELSE db_from.database_name
            END AS other_party_name

        FROM money_transfers mt

        LEFT JOIN user_database db_from 
            ON db_from.database_id = mt.from_database_id

        LEFT JOIN user_database db_to 
            ON db_to.database_id = mt.to_database_id

        WHERE 
            (mt.from_database_id = ? OR mt.to_database_id = ?)
            AND mt.is_deleted = 0
    `;

        const params = [
            database_id, // for direction
            database_id, // for other_party_name
            database_id, // WHERE
            database_id, // WHERE
        ];

        if (criteria.transfer_number) {
            sql += ` AND mt.transfer_number LIKE ?`;
            params.push(`%${criteria.transfer_number}%`);
        }

        if (criteria.to_database_id) {
            sql += ` AND mt.to_database_id = ?`;
            params.push(criteria.to_database_id);
        }

        if (criteria.start_date) {
            sql += ` AND DATE(mt.transfer_datetime) >= ?`;
            params.push(moment(criteria.start_date).format("YYYY-MM-DD"));
        }

        if (criteria.end_date) {
            sql += ` AND DATE(mt.transfer_datetime) <= ?`;
            params.push(moment(criteria.end_date).format("YYYY-MM-DD"));
        }

        sql += ` ORDER BY mt.transfer_datetime DESC`;

        const [rows] = await pool.execute(sql, params);

        return rows;
    }

    // create transfer money
    // Returns false (nothing written) when to_database_id is not a database the
    // receiver list offers this caller.
    static async create(database_id, transferData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // The same set GET /transfer/accounts offers the dialog: another database
            // with a live non-staff user. Anything else would post a transfer nobody can
            // see or confirm (the old name lookup crashed on an unknown id instead).
            const [[receiverDatabase]] = await connection.query(
                `SELECT d.database_id FROM user_database d
                INNER JOIN users u ON u.database_id = d.database_id
                WHERE d.database_id = ? AND d.database_id != ?
                  AND u.user_type != 'staff' AND u.is_deleted = 0
                LIMIT 1`,
                [transferData.to_database_id, database_id],
            );
            if (!receiverDatabase) {
                await connection.rollback();
                return false;
            }

            moment.tz.setDefault("Asia/Beirut");
            transferData.transfer_datetime = moment(
                transferData.transfer_datetime,
            ).format(`YYYY-MM-DD ${moment().format("HH:mm:ss")}`);

            let [[{ number }]] = await connection.query(
                `SELECT IFNULL(MAX(CAST(SUBSTRING(journal_number , 4) AS UNSIGNED)), 1000) + 1 AS number FROM journal_vouchers jv where journal_number like 'TRA%'`,
            );

            let payment_number = `TRA${number.toString().padStart(4, "0")}`;

            //get receiver account name
            const receiverName = await Transfer.getFirstName(
                connection,
                receiverDatabase.database_id,
            );

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers ( database_id, journal_number, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                payment_number,
                transferData.transfer_datetime,
                `Transfer`,
                transferData.amount,
            ]);

            const moneyAccountId = await Transfer.getMoneyAccountId(
                connection,
                transferData.money_account,
            );

            // from database
            const fromDatabase = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: transferData.transfer_datetime,
                account_id_fk: moneyAccountId,
                partner_id_fk: transferData.customer_id,
                debit: 0,
                credit: transferData.amount,
                notes: `To ${receiverName} (unconfirmed)`,
            };
            await connection.query(
                `INSERT INTO journal_items SET ?`,
                fromDatabase,
            );

            // NEW CODE
            const TransferQuery = `INSERT INTO money_transfers (journal_id, transfer_number, transfer_datetime, amount, money_account, from_database_id, to_database_id, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`;
            await connection.query(TransferQuery, [
                journal_voucher.insertId,
                payment_number,
                transferData.transfer_datetime,
                transferData.amount,
                transferData.money_account,
                database_id,
                receiverDatabase.database_id,
            ]);

            await connection.commit();
            return true;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // update transfer money
    // Only the sender, and only while the transfer is pending. The receiver cannot be
    // changed (the dialog shows it read-only): the stored one is kept, named in the
    // notes and returned for the socket notification.
    static async update(database_id, transfer_id, transferData) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const transfer = await Transfer.lockTransfer(
                connection,
                transfer_id,
                "from_database_id",
                database_id,
            );
            if (!transfer) {
                await connection.rollback();
                return { status: Transfer.NOT_FOUND };
            }
            if (transfer.is_approved) {
                await connection.rollback();
                return { status: Transfer.CONFIRMED };
            }
            const voucher = await Transfer.lockTransferVoucher(
                connection,
                transfer,
            );
            if (!voucher) {
                await connection.rollback();
                return { status: Transfer.NO_VOUCHER };
            }

            moment.tz.setDefault("Asia/Beirut");
            transferData.transfer_datetime = moment(
                transferData.transfer_datetime,
            ).format(`YYYY-MM-DD HH:mm:ss`);

            // update money_transfer record
            const updateTransferQuery = `UPDATE money_transfers SET transfer_datetime = ?, amount = ?, money_account = ? WHERE transfer_id = ? AND from_database_id = ?`;
            await connection.query(updateTransferQuery, [
                transferData.transfer_datetime,
                transferData.amount,
                transferData.money_account,
                transfer.transfer_id,
                database_id,
            ]);

            // update journal voucher
            const updateJournalVoucherQuery = `UPDATE journal_vouchers SET journal_date = ?, total_value = ? WHERE journal_id = ? AND database_id = ?`;
            await connection.query(updateJournalVoucherQuery, [
                transferData.transfer_datetime,
                transferData.amount,
                voucher.journal_id,
                database_id,
            ]);

            //get receiver account name
            const receiverName = await Transfer.getFirstName(
                connection,
                transfer.to_database_id,
            );

            const moneyAccountId = await Transfer.getMoneyAccountId(
                connection,
                transferData.money_account,
            );

            // update the sender's item; still pending, so still "(unconfirmed)" as
            // create() wrote it (confirmTransfer drops the suffix)
            const itemIds = await Transfer.getVoucherItemIds(
                connection,
                voucher,
                database_id,
                database_id,
            );
            if (itemIds.length) {
                await connection.query(
                    `UPDATE journal_items ji
                    INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                    SET ji.journal_date = ?, ji.account_id_fk = ?, ji.credit = ?, ji.notes = ?
                    WHERE ji.journal_item_id IN (?) AND ji.journal_id_fk = ? AND jv.database_id = ?`,
                    [
                        transferData.transfer_datetime,
                        moneyAccountId,
                        transferData.amount,
                        `To ${receiverName} (unconfirmed)`,
                        itemIds,
                        voucher.journal_id,
                        database_id,
                    ],
                );
            }

            await connection.commit();

            return {
                status: Transfer.OK,
                to_database_id: transfer.to_database_id,
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // delete transfer (hard delete, as before: nothing sets money_transfers.is_deleted)
    // Only the sender, and only while the transfer is pending.
    static async delete(database_id, transfer_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const transfer = await Transfer.lockTransfer(
                connection,
                transfer_id,
                "from_database_id",
                database_id,
            );
            if (!transfer) {
                await connection.rollback();
                return { status: Transfer.NOT_FOUND };
            }
            if (transfer.is_approved) {
                await connection.rollback();
                return { status: Transfer.CONFIRMED };
            }

            // The voucher and its items go with the transfer only when the voucher is
            // verified as the transfer's own (lockTransferVoucher). When it is not
            // (damaged data), the transfer is still deleted, since otherwise nobody could
            // ever remove it, but no voucher is touched.
            const voucher = await Transfer.lockTransferVoucher(
                connection,
                transfer,
            );
            if (voucher) {
                // every item of the voucher, whatever its database_id: balances are summed
                // from journal_items, so an item left without its voucher still counts
                const itemIds = await Transfer.getVoucherItemIds(
                    connection,
                    voucher,
                    database_id,
                );
                if (itemIds.length) {
                    await connection.query(
                        `DELETE ji FROM journal_items ji
                        INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                        WHERE ji.journal_item_id IN (?) AND ji.journal_id_fk = ? AND jv.database_id = ?`,
                        [itemIds, voucher.journal_id, database_id],
                    );
                }

                await connection.query(
                    `DELETE FROM journal_vouchers WHERE journal_id = ? AND database_id = ?`,
                    [voucher.journal_id, database_id],
                );
            }

            await connection.query(
                `DELETE FROM money_transfers WHERE transfer_id = ? AND from_database_id = ?`,
                [transfer.transfer_id, database_id],
            );

            await connection.commit();

            return {
                status: Transfer.OK,
                to_database_id: transfer.to_database_id,
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // confirm transfer
    // Only the receiver, and only while the transfer is pending.
    static async confirmTransfer(database_id, transfer_id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const transfer = await Transfer.lockTransfer(
                connection,
                transfer_id,
                "to_database_id",
                database_id,
            );
            if (!transfer) {
                await connection.rollback();
                return { status: Transfer.NOT_FOUND };
            }
            if (transfer.is_approved) {
                await connection.rollback();
                return { status: Transfer.CONFIRMED };
            }
            // the receiver's item is posted on this voucher, so it must be the sender's
            // TRA voucher and not whatever journal_id happens to point at
            const voucher = await Transfer.lockTransferVoucher(
                connection,
                transfer,
            );
            if (!voucher) {
                await connection.rollback();
                return { status: Transfer.NO_VOUCHER };
            }

            // set is_approved to 1
            const TransferQuery = `UPDATE money_transfers SET is_approved = 1 WHERE transfer_id = ? AND to_database_id = ?`;
            await connection.query(TransferQuery, [
                transfer.transfer_id,
                database_id,
            ]);

            const moneyAccountId = await Transfer.getMoneyAccountId(
                connection,
                transfer.money_account,
            );

            //get sender account name
            const senderName = await Transfer.getFirstName(
                connection,
                transfer.from_database_id,
            );

            //get receiver account name
            const receiverName = await Transfer.getFirstName(
                connection,
                transfer.to_database_id,
            );

            // update the sender's item note
            const senderItemIds = await Transfer.getVoucherItemIds(
                connection,
                voucher,
                transfer.from_database_id,
                transfer.from_database_id,
            );
            if (senderItemIds.length) {
                await connection.query(
                    `UPDATE journal_items ji
                    INNER JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
                    SET ji.notes = ?
                    WHERE ji.journal_item_id IN (?) AND ji.journal_id_fk = ? AND jv.database_id = ?`,
                    [
                        `To ${receiverName}`,
                        senderItemIds,
                        voucher.journal_id,
                        transfer.from_database_id,
                    ],
                );
            }

            // insert new journal item for receiver
            const toDatabase = {
                database_id: transfer.to_database_id,
                journal_id_fk: voucher.journal_id,
                journal_date: transfer.transfer_datetime,
                account_id_fk: moneyAccountId,
                debit: transfer.amount,
                credit: 0,
                notes: `From ${senderName}`,
            };

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                toDatabase,
            );

            await connection.commit();

            return {
                status: Transfer.OK,
                socketData: {
                    name: receiverName,
                    database_id: transfer.from_database_id,
                },
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = Transfer;
