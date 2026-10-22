const pool = require("../../config/database");
const { toCents, toMoney, splitShare } = require("./money");
const { monthBounds, monthsBetween, monthOf } = require("./dates");
const M = require("./metrics");

// Partner account of each user shop (plan §8 Phase 7.1 part F; owner answers
// 2026-10-22). All figures in integer cents.
//
// - M31 Earned(u): Σ over the months from PARTNER_START_MONTH to the last counted month
//   L of splitShare(M10(u, m), current share %).user. Each month is split on its own
//   and rounded half away from zero (M14, D4); loss months subtract. It equals the
//   Financial profit-share rows of those months to the cent (same four bucketed
//   statements, same split). The CURRENT share % is used for every month (A4, PA8): a
//   change restates every month since the start.
// - M32 Taken(u): Σ(debit − credit) of the journal lines on 108 Partner Drawings with
//   ji.database_id = u, ji.is_deleted = 0 and jv.journal_date in [start day, L + 1).
//   Approval vouchers count on the take date (PA4); a reversal carries the same date and
//   cancels them (PA3). No entry is dated before the start (opening entries, PA13, were
//   rejected by the owner, L1-5). The filters are M20 / M20-AT's, so cash and taken stay
//   paired. Read from the journal, never from partner_shares (PA5).
// - M33 Untaken(u) = M31 − M32, signed, never floored (a floor would break the
//   invariant of part B: approving moves cash and taken by the same amount).
// - Pending entries (now view only) are information: they post nothing (PA2).
//
// Before §7.7 (PA15) nothing throws: without 108 the taken statement is not issued and
// taken is 0 (exact: no SHR voucher can exist without it); without partner_shares the
// pending count is 0. Either case sets notSetUp, which the pages turn into the
// admin-only note PARTNER_NOT_SET_UP.
//
// The page appends partnerThunks() to its OWN runLimited list, so no more than 4
// statements are ever in flight (§3.1), and folds the results with partnerFold().

// Shares count from this month (O3); earlier months were settled outside the app. The
// thunks take the start month as an option, so a read-only check can move it back.
const PARTNER_START_MONTH = "2026-11";
const PARTNER_START_DAY = `${PARTNER_START_MONTH}-01`;

// Uses idx_rk_ji_db_acc. Grouped by the voucher's month, as the profit-share buckets.
const TAKEN_MONTHS_SQL = `/* rk:partner.taken_months */
SELECT ji.database_id, DATE_FORMAT(jv.journal_date, ?) AS bucket,
       ROUND(SUM(ji.debit - ji.credit), 2) AS taken
FROM journal_items ji
JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
WHERE ji.database_id IN (?) AND ji.is_deleted = 0 AND ji.account_id_fk = ?
  AND jv.journal_date >= ? AND jv.journal_date < ?
GROUP BY ji.database_id, bucket`;

// Now view only; uses idx_ps_db_status
const PENDING_SQL = `/* rk:partner.pending */
SELECT database_id, COUNT(*) AS n, ROUND(SUM(amount), 2) AS amount
FROM partner_shares
WHERE database_id IN (?) AND status = 'pending' AND is_deleted = 0
GROUP BY database_id`;

/** Rows { database_id, bucket ('YYYY-MM'), taken_c } of the lines on 108 in [lo, hi). */
async function takenMonths(U, a108, lo, hi) {
    const [rows] = await pool.query(TAKEN_MONTHS_SQL, ["%Y-%m", U, a108, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        bucket: String(r.bucket),
        taken_c: toCents(r.taken),
    }));
}

/**
 * Map db → { count, amount_c } of the pending, live entries; `missing` when the table
 * does not exist yet (§7.7 not run, PA15, the D-P7.2-S1 rule).
 */
async function pendingShares(U) {
    let rows;
    try {
        [rows] = await pool.query(PENDING_SQL, [U]);
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return { byTenant: new Map(), missing: true };
        throw error;
    }
    return {
        byTenant: new Map(
            rows.map((r) => [
                Number(r.database_id),
                { count: Number(r.n ?? 0), amount_c: toCents(r.amount) },
            ]),
        ),
        missing: false,
    };
}

/**
 * The partner statements of the user tenants U, as tagged thunks for the page's own
 * runLimited list: 4 M10 statements by month, taken (M32) and, withPending, the pending
 * entries. None at all when U is empty or the last counted month is before the start
 * month (everything is then 0).
 *
 * @param {number[]} U  user tenants (never the admin's)
 * @param {object} opts
 * @param {string} opts.lastMonth  L, 'YYYY-MM': the current Beirut month (now view) or
 *   as_of's month (month end)
 * @param {() => Promise<object>} opts.ids  the page's memoised accounts.getAccountIds()
 * @param {boolean} [opts.withPending]  now view only
 * @param {string} [opts.startMonth]  PARTNER_START_MONTH unless a check moves it back
 * @returns {Array<() => Promise<{kind: string}>>}
 */
function partnerThunks(U, { lastMonth, ids, withPending = false, startMonth = PARTNER_START_MONTH }) {
    if (!U.length || lastMonth < startMonth) return [];
    const lo = monthBounds(startMonth).lo;
    // the first day after L: the month end's cut in the month-end view
    const hi = monthBounds(lastMonth).hi;
    const thunks = [
        async () => ({ kind: "sales", rows: await M.salesTotals(U, lo, hi, "%Y-%m") }),
        async () => ({ kind: "returns", rows: await M.returnsTotals(U, lo, hi, "%Y-%m") }),
        async () => ({ kind: "disposals", rows: await M.disposals(U, lo, hi, "%Y-%m") }),
        async () => ({ kind: "expenses", rows: await M.expenses(U, lo, hi, "%Y-%m") }),
        async () => {
            const { a108 } = await ids();
            // Before §7.7: no statement, taken is 0 (PA15)
            if (a108 === null || a108 === undefined) {
                return { kind: "taken", rows: [], notSetUp: true };
            }
            return { kind: "taken", rows: await takenMonths(U, a108, lo, hi), notSetUp: false };
        },
    ];
    if (withPending) {
        thunks.push(async () => ({ kind: "pending", ...(await pendingShares(U)) }));
    }
    return thunks;
}

/**
 * Fold the results of partnerThunks() (in any order, other results ignored).
 *
 * @param {Array} results  the page's runLimited results (the partner ones are tagged)
 * @param {number[]} U  the same tenants
 * @param {(u: number) => number} bpOf  the CURRENT share % of u in basis points (A4)
 * @param {object} opts
 * @param {moment.Moment} opts.now  Beirut now
 * @param {string} opts.lastMonth  L
 * @param {boolean} [opts.withPending]  pending was asked for (else null fields)
 * @param {boolean} [opts.monthEnd]  month-end view: no month is in progress
 * @param {string} [opts.startMonth]
 * @returns {{ byTenant: Map<number, { earned_c: number, taken_c: number,
 *   untaken_c: number, pending_count: number|null, pending_c: number|null,
 *   months: Array<{ month: string, earned_c: number, taken_c: number,
 *   untaken_after_c: number, in_progress: boolean }> }>, notSetUp: boolean }}
 */
function partnerFold(
    results,
    U,
    bpOf,
    { now, lastMonth, withPending = false, monthEnd = false, startMonth = PARTNER_START_MONTH },
) {
    const tagged = (kind) => results.find((r) => r && typeof r === "object" && r.kind === kind);
    const cells = (kind, field) => {
        const map = new Map();
        for (const r of tagged(kind)?.rows ?? []) {
            map.set(`${r.database_id}|${r.bucket}`, r[field]);
        }
        return map;
    };
    const sales = new Map((tagged("sales")?.rows ?? []).map((r) => [`${r.database_id}|${r.bucket}`, r]));
    const returns = new Map((tagged("returns")?.rows ?? []).map((r) => [`${r.database_id}|${r.bucket}`, r]));
    const disposed = cells("disposals", "disposed_c");
    const expenses = cells("expenses", "expenses_c");
    const taken = cells("taken", "taken_c");
    const pending = tagged("pending");

    const months = lastMonth >= startMonth ? monthsBetween(startMonth, lastMonth) : [];
    const current = monthOf(now);

    const byTenant = new Map();
    for (const u of U) {
        const share = bpOf(u);
        let earned = 0;
        let takenSum = 0;
        const list = months.map((m) => {
            const k = `${u}|${m}`;
            const s = sales.get(k);
            const r = returns.get(k);
            // M10 = (sales − returns) − (cogs − returns cost) − disposals − expenses,
            // Financial's pnlCents
            const np =
                (s ? s.sales_c : 0) -
                (r ? r.returns_c : 0) -
                ((s ? s.cogs_c : 0) - (r ? r.rcost_c : 0)) -
                (disposed.get(k) || 0) -
                (expenses.get(k) || 0);
            const e = splitShare(np, share).user;
            const t = taken.get(k) || 0;
            earned += e;
            takenSum += t;
            return {
                month: m,
                earned_c: e,
                taken_c: t,
                untaken_after_c: earned - takenSum,
                in_progress: !monthEnd && m === current,
            };
        });
        const p = pending?.byTenant?.get(u);
        byTenant.set(u, {
            earned_c: earned,
            taken_c: takenSum,
            untaken_c: earned - takenSum,
            pending_count: withPending ? (p ? p.count : 0) : null,
            pending_c: withPending ? (p ? p.amount_c : 0) : null,
            months: list,
        });
    }
    return {
        byTenant,
        notSetUp: Boolean(tagged("taken")?.notSetUp || pending?.missing),
    };
}

/** The empty account of a tenant the partner statements did not cover. */
const emptyAccount = (withPending = false) => ({
    earned_c: 0,
    taken_c: 0,
    untaken_c: 0,
    pending_count: withPending ? 0 : null,
    pending_c: withPending ? 0 : null,
    months: [],
});

/** A partner month as sent ('…_profit_share' names: stripped for restricted viewers). */
const monthRow = (m) => ({
    month: m.month,
    earned_profit_share: toMoney(m.earned_c),
    taken_profit_share: toMoney(m.taken_c),
    untaken_profit_share_after: toMoney(m.untaken_after_c),
    in_progress: m.in_progress,
});

module.exports = {
    PARTNER_START_MONTH,
    PARTNER_START_DAY,
    partnerThunks,
    partnerFold,
    emptyAccount,
    monthRow,
    pendingShares,
};
