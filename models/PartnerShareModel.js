const pool = require("../config/database");
const { toCents, toMoney, bp } = require("./reports-v2/money");
const { getAccountIds } = require("./reports-v2/accounts");
const { loadDirectory, buildTenants } = require("./reports-v2/scope");
const { monthOf, monthBounds } = require("./reports-v2/dates");
const M = require("./reports-v2/metrics");
const P = require("./reports-v2/partner");

// Partner shares taken (plan §8 Phase 7.1 parts C–E; owner answers 2026-10-22).
//
// A user records the profit share he took from his own till (Cash 531 or Whish 532) as a
// PENDING entry, which posts nothing (PA2). Only the admin approves it; approval posts
// one voucher on the user's tenant, numbered as the entry (SHR####), dated the day the
// cash left the till (taken_at, PA4): Dr 108 Partner Drawings / Cr 531|532. Cash goes
// down and the taken share (M32, read from the journal, PA5) goes up by the same amount
// on the same date, so cash − untaken, the cap use (M30) and the money held for the
// admin (M34) never move on approve, reject, delete or reverse (part B).
//
// - An approved entry is never edited or deleted: the admin reverses it with SHR####-R,
//   Dr 531|532 / Cr 108, dated at the approval voucher's date (a void, PA3, confirmed by
//   the owner 2026-10-22, L1-1: REVERSAL_AT_ENTRY_DATE).
// - A pending entry can be withdrawn by its user, or rejected (with a reason) or deleted
//   by the admin; deletes are soft (PA2).
// - Entry numbers come from the row id (PA9): no MAX()+1 race.
// - The money account is a string everywhere: a NUMBER bound to ENUM('531','532') is
//   read as the member's position and fails in strict mode (part C).
// - Every state change locks its row (SELECT … FOR UPDATE, the TransferModel pattern),
//   checks the state, and writes with a guarded UPDATE (… AND status = ? AND
//   is_deleted = 0) whose affectedRows must be 1, else everything rolls back.
// - No balance is read or locked on approval (PA6): a negative cash or an overdrawn
//   share is only warned about (the admin's preview; confirmed by the owner, L1-2 and
//   L1-3).
// - No opening entries: the owner rejected PA13 (L1-5, 2026-10-22). Every entry is dated
//   inside the controller's window (PA16), so never before the start day.
// - Chart ids are read on the transaction's connection (TransferModel.getMoneyAccountId:
//   a second pool connection inside a transaction can deadlock the pool).
// - Before §7.7 (PA15): no 108 row or no partner_shares table → NOT_SET_UP (409) on the
//   write routes; search answers set_up: false and the badge 0.
// - Statements carry /* rk:partner_shares.* */ markers, as the reports' do (logs, tests).

const SHARE_NOT_SET_UP_CODE = "ER_NO_SUCH_TABLE";
const flag = (v) => Boolean(Number(v));
const str = (v) => (v === null || v === undefined ? null : String(v));

// The row and its lock: live rows only (a deleted entry answers as an unknown one). The
// user-side variant also binds his tenant, so another shop's id is "not found".
const LOCK_SQL = `/* rk:partner_shares.lock */ SELECT share_id, share_number, database_id, amount, money_account, taken_at, status, journal_id
FROM partner_shares WHERE share_id = ? AND is_deleted = 0 FOR UPDATE`;
const LOCK_OWN_SQL = `/* rk:partner_shares.lock_own */ SELECT share_id, share_number, database_id, amount, money_account, taken_at, status, journal_id
FROM partner_shares WHERE share_id = ? AND database_id = ? AND is_deleted = 0 FOR UPDATE`;

// Search filters: fixed fragments chosen from constant keys, never built from input
const STATUS_WHERE = {
    pending: "ps.status = 'pending' AND ps.is_deleted = 0",
    approved: "ps.status = 'approved' AND ps.is_deleted = 0",
    rejected: "ps.status = 'rejected' AND ps.is_deleted = 0",
    reversed: "ps.status = 'reversed' AND ps.is_deleted = 0",
    // admin: every soft-deleted entry; user: only those the admin deleted (his own
    // withdrawn ones are never listed back to him)
    deleted_admin: "ps.is_deleted = 1",
    deleted_user: "ps.is_deleted = 1 AND COALESCE(ps.deleted_by_user_id, 0) <> ps.created_by_user_id",
    all_admin: "ps.is_deleted = 0",
    all_user:
        "(ps.is_deleted = 0 OR COALESCE(ps.deleted_by_user_id, 0) <> ps.created_by_user_id)",
};

// Names: users.first_name and user_database.database_name only (no other users column)
const LIST_SQL = (where) => `/* rk:partner_shares.list */ SELECT ps.share_id, ps.share_number, ps.database_id, ud.database_name AS shop_name,
       ps.amount, ps.money_account, ps.taken_at, ps.note, ps.status, ps.is_deleted,
       ps.created_by_user_id, ps.deleted_by_user_id, ps.reject_reason, ps.created_at,
       cu.first_name AS created_by_name, ps.approved_at, au.first_name AS approved_by_name,
       ps.rejected_at, ps.reversed_at, ps.journal_id, ps.reversal_journal_id
FROM partner_shares ps
LEFT JOIN user_database ud ON ud.database_id = ps.database_id
LEFT JOIN users cu ON cu.user_id = ps.created_by_user_id
LEFT JOIN users au ON au.user_id = ps.approved_by_user_id
WHERE ${where} AND (? IS NULL OR ps.database_id = ?)
ORDER BY ps.created_at DESC, ps.share_id DESC
LIMIT ? OFFSET ?`;
const COUNT_SQL = (where) => `/* rk:partner_shares.count */ SELECT COUNT(*) AS n FROM partner_shares ps
WHERE ${where} AND (? IS NULL OR ps.database_id = ?)`;

// The two postings (part E). The voucher's description (the label Cash history shows,
// reserved in Expense.controller) and the lines' notes are fixed texts in the SQL; only
// the tenant, number, date, money account, amount and account ids are bound.
const POSTING_SQL = {
    approve: {
        voucher: `/* rk:partner_shares.voucher */ INSERT INTO journal_vouchers (database_id, journal_number, journal_date, journal_description, journal_notes, total_value) VALUES (?, ?, ?, 'Share Taken', ?, ?)`,
        items: `/* rk:partner_shares.items */ INSERT INTO journal_items (database_id, journal_id_fk, journal_date, account_id_fk, debit, credit, notes, reference_number) VALUES (?, ?, ?, ?, ?, 0, 'Share taken', ?), (?, ?, ?, ?, 0, ?, 'Share taken', ?)`,
    },
    reverse: {
        voucher: `/* rk:partner_shares.reversal_voucher */ INSERT INTO journal_vouchers (database_id, journal_number, journal_date, journal_description, journal_notes, total_value) VALUES (?, ?, ?, 'Share Taken Reversal', ?, ?)`,
        items: `/* rk:partner_shares.reversal_items */ INSERT INTO journal_items (database_id, journal_id_fk, journal_date, account_id_fk, debit, credit, notes, reference_number) VALUES (?, ?, ?, ?, ?, 0, 'Share taken reversed', ?), (?, ?, ?, ?, 0, ?, 'Share taken reversed', ?)`,
    },
};

class PartnerShare {
    // Outcomes; every one but OK is returned after a rollback, with nothing written
    static OK = "ok";
    static NOT_FOUND = "not_found";
    static CONFLICT = "conflict";
    static NO_VOUCHER = "no_voucher";
    static NOT_SET_UP = "not_set_up";
    static FORBIDDEN = "forbidden";

    // The accounts a share can be taken from (as Transfer.MONEY_ACCOUNTS)
    static MONEY_ACCOUNTS = ["531", "532"];

    // PA3 (confirmed by the owner 2026-10-22, L1-1): a reversal is dated at the approval
    // voucher's date, a void. false = dated when the admin reverses it.
    static REVERSAL_AT_ENTRY_DATE = true;

    /** 'SHR' + (1000 + share_id), at least 4 digits (PA9): SHR1001. */
    static numberOf(share_id) {
        return `SHR${String(1000 + share_id).padStart(4, "0")}`;
    }

    static async lock(connection, share_id, ownDatabaseId = null) {
        const [[share]] =
            ownDatabaseId === null
                ? await connection.query(LOCK_SQL, [share_id])
                : await connection.query(LOCK_OWN_SQL, [share_id, ownDatabaseId]);
        return share;
    }

    // 108 and the entry's money account, on the transaction's connection. The account
    // number is bound as the ENUM's string value (part E step 2).
    static async chartIds(connection, moneyAccount) {
        const [rows] = await connection.query(
            `/* rk:partner_shares.chart */ SELECT id, account_number FROM chart_of_accounts WHERE account_number IN ('108', ?) ORDER BY id`,
            [String(moneyAccount)],
        );
        const byNumber = new Map();
        for (const row of rows) {
            const number = String(row.account_number);
            if (!byNumber.has(number)) byNumber.set(number, Number(row.id));
        }
        return { a108: byNumber.get("108") ?? null, aMoney: byNumber.get(String(moneyAccount)) ?? null };
    }

    // One voucher and its two lines, on the user's tenant, dated `date` on the voucher and
    // on both lines (the legacy cash report reads ji.journal_date). reference_number is
    // the voucher's number, never 'manual' (the legacy manual-cash sum leaves it out).
    // `kind` picks the fixed SQL: 'approve' (Dr 108 / Cr money) or 'reverse' (the mirror).
    static async postVoucher(connection, kind, { database_id, number, date, moneyAccount, amount, debitId, creditId }) {
        const sql = POSTING_SQL[kind];
        const [voucher] = await connection.query(sql.voucher, [
            database_id,
            number,
            date,
            moneyAccount,
            amount,
        ]);
        await connection.query(sql.items, [
            database_id, voucher.insertId, date, debitId, amount, number,
            database_id, voucher.insertId, date, creditId, amount, number,
        ]);
        return voucher.insertId;
    }

    /**
     * §7.7 has run: the chart has 108 (accounts.js re-reads the chart while it is
     * missing, PA15). Checked before a write route opens its transaction, so a missing
     * 108 answers NOT_SET_UP (409) on every write; a missing table is caught inside it.
     */
    static async isSetUp() {
        const { a108 } = await getAccountIds();
        return a108 !== null && a108 !== undefined;
    }

    static async inTransaction(work) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const result = await work(connection);
            if (result.status === PartnerShare.OK) await connection.commit();
            else await connection.rollback();
            return result;
        } catch (error) {
            await connection.rollback();
            // §7.7 not run yet: the table is missing (PA15)
            if (error?.code === SHARE_NOT_SET_UP_CODE) {
                return { status: PartnerShare.NOT_SET_UP };
            }
            throw error;
        } finally {
            connection.release();
        }
    }

    /**
     * A pending entry on the user's own tenant (PA1). `entry` is the controller's checked
     * values: amount (a 2-decimal string), money_account ('531'|'532'), taken_date
     * ('YYYY-MM-DD'), note (string|null). `now` is Beirut now (moment).
     */
    static async create(viewer, entry, now) {
        return PartnerShare.inTransaction(async (connection) => {
            // Belt: a tenant with an admin login never records a share; and nothing is
            // recorded while 108 is missing (it could never be approved, PA15)
            const [[check]] = await connection.query(
                `/* rk:partner_shares.create_check */ SELECT (SELECT id FROM chart_of_accounts WHERE account_number = '108' ORDER BY id LIMIT 1) AS a108,
                  EXISTS (SELECT 1 FROM users WHERE database_id = ? AND user_type = 'admin') AS has_admin`,
                [viewer.databaseId],
            );
            if (flag(check?.has_admin)) return { status: PartnerShare.FORBIDDEN };
            if (check?.a108 === null || check?.a108 === undefined) {
                return { status: PartnerShare.NOT_SET_UP };
            }

            // Beirut: the day the user took it + the entry time (the transfer rule)
            const takenAt = `${entry.taken_date} ${now.format("HH:mm:ss")}`;
            const [result] = await connection.query(
                `/* rk:partner_shares.insert */ INSERT INTO partner_shares (database_id, amount, money_account, taken_at, note, status, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
                [
                    viewer.databaseId,
                    entry.amount,
                    entry.money_account,
                    takenAt,
                    entry.note,
                    Number(viewer.userId),
                    now.format("YYYY-MM-DD HH:mm:ss"),
                ],
            );
            const share_id = Number(result.insertId);
            const share_number = PartnerShare.numberOf(share_id);
            await connection.query(
                `/* rk:partner_shares.number */ UPDATE partner_shares SET share_number = ? WHERE share_id = ?`,
                [share_number, share_id],
            );
            return {
                status: PartnerShare.OK,
                share_id,
                share_number,
                database_id: viewer.databaseId,
            };
        });
    }

    /** Pending → approved; posts the SHR voucher (part E). Admin only. */
    static async approve(viewer, share_id, now) {
        if (!(await PartnerShare.isSetUp())) return { status: PartnerShare.NOT_SET_UP };
        return PartnerShare.inTransaction(async (connection) => {
            const share = await PartnerShare.lock(connection, share_id);
            if (!share) return { status: PartnerShare.NOT_FOUND };
            if (share.status !== "pending") {
                return { status: PartnerShare.CONFLICT, current: String(share.status) };
            }

            const moneyAccount = String(share.money_account);
            const { a108, aMoney } = await PartnerShare.chartIds(connection, moneyAccount);
            if (a108 === null) return { status: PartnerShare.NOT_SET_UP };
            if (aMoney === null) throw new Error(`Chart account ${moneyAccount} not found`);

            const amount = toMoney(toCents(share.amount));
            const takenAt = String(share.taken_at);
            const journalId = await PartnerShare.postVoucher(connection, "approve", {
                database_id: Number(share.database_id),
                number: String(share.share_number),
                date: takenAt,
                moneyAccount,
                amount,
                debitId: a108,
                creditId: aMoney,
            });

            const [update] = await connection.query(
                `/* rk:partner_shares.approve */ UPDATE partner_shares SET status = 'approved', approved_by_user_id = ?, approved_at = ?, journal_id = ? WHERE share_id = ? AND status = 'pending' AND is_deleted = 0`,
                [Number(viewer.userId), now.format("YYYY-MM-DD HH:mm:ss"), journalId, share.share_id],
            );
            if (update.affectedRows !== 1) {
                return { status: PartnerShare.CONFLICT, current: "pending" };
            }
            return {
                status: PartnerShare.OK,
                database_id: Number(share.database_id),
                share_number: share.share_number,
                journal_number: share.share_number,
            };
        });
    }

    /** Approved → reversed; posts SHR####-R (PA3). Admin only. */
    static async reverse(viewer, share_id, now) {
        if (!(await PartnerShare.isSetUp())) return { status: PartnerShare.NOT_SET_UP };
        return PartnerShare.inTransaction(async (connection) => {
            const share = await PartnerShare.lock(connection, share_id);
            if (!share) return { status: PartnerShare.NOT_FOUND };
            if (share.status !== "approved") {
                return { status: PartnerShare.CONFLICT, current: String(share.status) };
            }

            // journal_id is trusted only while it points at this entry's own SHR voucher on
            // its tenant (the lockTransferVoucher rule): otherwise nothing is written
            const [[voucher]] = await connection.query(
                `/* rk:partner_shares.voucher_lock */ SELECT journal_id, journal_date FROM journal_vouchers
                WHERE journal_id = ? AND database_id = ? AND journal_number = ? AND journal_number LIKE 'SHR%'
                FOR UPDATE`,
                [share.journal_id ?? 0, Number(share.database_id), String(share.share_number)],
            );
            if (!voucher) {
                return { status: PartnerShare.NO_VOUCHER, share_number: share.share_number };
            }

            const moneyAccount = String(share.money_account);
            const { a108, aMoney } = await PartnerShare.chartIds(connection, moneyAccount);
            if (a108 === null) return { status: PartnerShare.NOT_SET_UP };
            if (aMoney === null) throw new Error(`Chart account ${moneyAccount} not found`);

            const nowText = now.format("YYYY-MM-DD HH:mm:ss");
            const number = `${share.share_number}-R`;
            // PA3: on the date of the voucher it cancels (a void)
            const date = PartnerShare.REVERSAL_AT_ENTRY_DATE ? String(voucher.journal_date) : nowText;
            const reversalId = await PartnerShare.postVoucher(connection, "reverse", {
                database_id: Number(share.database_id),
                number,
                date,
                moneyAccount,
                amount: toMoney(toCents(share.amount)),
                debitId: aMoney,
                creditId: a108,
            });

            const [update] = await connection.query(
                `/* rk:partner_shares.reverse */ UPDATE partner_shares SET status = 'reversed', reversed_by_user_id = ?, reversed_at = ?, reversal_journal_id = ? WHERE share_id = ? AND status = 'approved' AND is_deleted = 0`,
                [Number(viewer.userId), nowText, reversalId, share.share_id],
            );
            if (update.affectedRows !== 1) {
                return { status: PartnerShare.CONFLICT, current: "approved" };
            }
            return {
                status: PartnerShare.OK,
                database_id: Number(share.database_id),
                share_number: share.share_number,
                reversal_journal_number: number,
            };
        });
    }

    /** Pending → rejected, with an optional reason (string|null). Admin only. */
    static async reject(viewer, share_id, reason, now) {
        if (!(await PartnerShare.isSetUp())) return { status: PartnerShare.NOT_SET_UP };
        return PartnerShare.inTransaction(async (connection) => {
            const share = await PartnerShare.lock(connection, share_id);
            if (!share) return { status: PartnerShare.NOT_FOUND };
            if (share.status !== "pending") {
                return { status: PartnerShare.CONFLICT, current: String(share.status) };
            }
            const [update] = await connection.query(
                `/* rk:partner_shares.reject */ UPDATE partner_shares SET status = 'rejected', rejected_by_user_id = ?, rejected_at = ?, reject_reason = ? WHERE share_id = ? AND status = 'pending' AND is_deleted = 0`,
                [Number(viewer.userId), now.format("YYYY-MM-DD HH:mm:ss"), reason, share.share_id],
            );
            if (update.affectedRows !== 1) {
                return { status: PartnerShare.CONFLICT, current: "pending" };
            }
            return {
                status: PartnerShare.OK,
                database_id: Number(share.database_id),
                share_number: share.share_number,
            };
        });
    }

    /**
     * Soft-delete a pending entry: the admin any, a user only his own (withdraw); another
     * shop's entry is "not found" for a user (PA2).
     */
    static async remove(viewer, share_id, now) {
        if (!(await PartnerShare.isSetUp())) return { status: PartnerShare.NOT_SET_UP };
        return PartnerShare.inTransaction(async (connection) => {
            const own = viewer.isAdmin ? null : viewer.databaseId;
            const share = await PartnerShare.lock(connection, share_id, own);
            if (!share) return { status: PartnerShare.NOT_FOUND };
            if (share.status !== "pending") {
                return { status: PartnerShare.CONFLICT, current: String(share.status) };
            }
            const [update] =
                own === null
                    ? await connection.query(
                          `/* rk:partner_shares.delete */ UPDATE partner_shares SET is_deleted = 1, deleted_by_user_id = ?, deleted_at = ? WHERE share_id = ? AND status = 'pending' AND is_deleted = 0`,
                          [Number(viewer.userId), now.format("YYYY-MM-DD HH:mm:ss"), share.share_id],
                      )
                    : await connection.query(
                          `/* rk:partner_shares.delete_own */ UPDATE partner_shares SET is_deleted = 1, deleted_by_user_id = ?, deleted_at = ? WHERE share_id = ? AND database_id = ? AND status = 'pending' AND is_deleted = 0`,
                          [Number(viewer.userId), now.format("YYYY-MM-DD HH:mm:ss"), share.share_id, own],
                      );
            if (update.affectedRows !== 1) {
                return { status: PartnerShare.CONFLICT, current: "pending" };
            }
            return {
                status: PartnerShare.OK,
                database_id: Number(share.database_id),
                share_number: share.share_number,
            };
        });
    }

    /** The admin's badge: pending, live entries; 0 while the table is missing (PA15). */
    static async pendingCount() {
        try {
            const [[row]] = await pool.query(
                `/* rk:partner_shares.pending_count */ SELECT COUNT(*) AS n FROM partner_shares WHERE status = 'pending' AND is_deleted = 0`,
            );
            return Number(row?.n ?? 0);
        } catch (error) {
            if (error?.code === SHARE_NOT_SET_UP_CODE) return 0;
            throw error;
        }
    }

    /** A partner_shares row as the ShareRow the client reads. */
    static shareRow(r) {
        const deleted = flag(r.is_deleted);
        return {
            share_id: Number(r.share_id),
            share_number: str(r.share_number),
            database_id: Number(r.database_id),
            shop_name: String(r.shop_name ?? "").trim() || `Shop ${r.database_id}`,
            amount: toMoney(toCents(r.amount)),
            money_account: String(r.money_account),
            taken_at: String(r.taken_at),
            note: str(r.note),
            status: String(r.status),
            deleted: !deleted
                ? null
                : Number(r.deleted_by_user_id) !== Number(r.created_by_user_id)
                  ? "by_admin"
                  : "withdrawn",
            reject_reason: str(r.reject_reason),
            created_at: str(r.created_at),
            created_by_name: str(r.created_by_name),
            approved_at: str(r.approved_at),
            approved_by_name: str(r.approved_by_name),
            rejected_at: str(r.rejected_at),
            reversed_at: str(r.reversed_at),
            // the vouchers carry the entry's own number (PA9)
            journal_number: r.journal_id ? str(r.share_number) : null,
            reversal_journal_number: r.reversal_journal_id ? `${r.share_number}-R` : null,
        };
    }

    /**
     * The list (and, for the admin, the shop cards and the approve previews).
     *
     * @param {object} viewer  access.loadViewer()
     * @param {{ status: string, databaseId: number|null, limit: number, offset: number }} q
     * @param {moment.Moment} now  Beirut now
     * @returns {Promise<{ set_up: boolean, total: number, rows: object[], shops?: object[] }>}
     */
    static async search(viewer, q, now) {
        const admin = viewer.isAdmin;
        const empty = { set_up: false, total: 0, rows: [], ...(admin ? { shops: [] } : {}) };

        // §7.7 not run (PA15): no 108 → nothing can be approved; nothing to list
        const ids = await getAccountIds();
        if (ids.a108 === null) return empty;

        let directory = null;
        let users = [];
        let tenantFilter;
        if (admin) {
            directory = await loadDirectory();
            users = buildTenants(directory, {
                reports: { isAdmin: true, databaseId: viewer.databaseId },
            }).filter((t) => t.role === "user");
            tenantFilter = q.databaseId;
            // an id that is not a user shop of the directory lists nothing
            if (tenantFilter !== null && !users.some((t) => t.database_id === tenantFilter)) {
                tenantFilter = -1;
            }
        } else {
            // a user's own shop only, whatever the body says
            tenantFilter = viewer.databaseId;
        }

        const key =
            q.status === "deleted" || q.status === "all"
                ? `${q.status}_${admin ? "admin" : "user"}`
                : q.status;
        const where = STATUS_WHERE[key];
        if (!where) throw new Error(`Unknown share status filter: ${q.status}`);

        let total;
        let list;
        if (tenantFilter === -1) {
            total = 0;
            list = [];
        } else {
            try {
                const [[count]] = await pool.query(COUNT_SQL(where), [tenantFilter, tenantFilter]);
                total = Number(count?.n ?? 0);
                [list] = await pool.query(LIST_SQL(where), [
                    tenantFilter,
                    tenantFilter,
                    q.limit,
                    q.offset,
                ]);
            } catch (error) {
                if (error?.code === SHARE_NOT_SET_UP_CODE) return empty;
                throw error;
            }
        }
        const rows = list.map(PartnerShare.shareRow);
        if (!admin) return { set_up: true, total, rows };

        // ---- admin: one card per user shop (inactive ones included, chip order) and a
        // preview on every pending row, as if only that entry were approved (PA6, PA7,
        // PA16). Earned and taken through the current month; pending always.
        const U = users.map((t) => t.database_id);
        const lastMonth = monthOf(now);
        const memo = Promise.resolve(ids);
        const shareBp = new Map(users.map((t) => [t.database_id, bp(t.share_pct ?? "0.00")]));
        const thunks = P.partnerThunks(U, { lastMonth, ids: () => memo });
        const results = U.length
            ? await M.runLimited([
                  () => M.cashWhish(U, ids),
                  async () => ({ kind: "pending", ...(await P.pendingShares(U)) }),
                  ...thunks,
              ])
            : [new Map(), { kind: "pending", byTenant: new Map(), missing: false }];
        const cash = results[0];
        const pending = results[1];
        const partner = P.partnerFold(results.slice(2), U, (t) => shareBp.get(t) ?? 0, {
            now,
            lastMonth,
        });
        const accountOf = (t) => partner.byTenant.get(t) || P.emptyAccount();
        const cashOf = (t) => cash.get(t) || { cash_c: 0, whish_c: 0 };

        const shops = users.map((t) => {
            const a = accountOf(t.database_id);
            const p = pending.byTenant.get(t.database_id) || { count: 0, amount_c: 0 };
            const c = cashOf(t.database_id);
            return {
                database_id: t.database_id,
                name: t.name,
                active: t.active,
                share_pct: t.share_pct,
                earned_profit_share: toMoney(a.earned_c),
                taken_profit_share: toMoney(a.taken_c),
                untaken_profit_share: toMoney(a.untaken_c),
                pending_count: p.count,
                pending_amount: toMoney(p.amount_c),
                cash: toMoney(c.cash_c),
                whish: toMoney(c.whish_c),
            };
        });

        const monthStart = monthBounds(lastMonth).lo;
        for (const row of rows) {
            if (row.status !== "pending" || row.deleted !== null) continue;
            const a = accountOf(row.database_id);
            const c = cashOf(row.database_id);
            const amountC = toCents(row.amount);
            const balance = row.money_account === "532" ? c.whish_c : c.cash_c;
            const untakenAfter = a.untaken_c - amountC;
            row.preview = {
                account_balance: toMoney(balance),
                account_balance_after: toMoney(balance - amountC),
                untaken_profit_share_after: toMoney(untakenAfter),
                negative_balance: balance - amountC < 0,
                overdraws: untakenAfter < 0,
                closed_month: row.taken_at < monthStart,
            };
        }
        return { set_up: true, total, rows, shops };
    }
}

module.exports = PartnerShare;
