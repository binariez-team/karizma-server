const pool = require("../../config/database");
const { toCents, toMoney, asMoney, pct, bp, splitShare } = require("./money");
const {
    nowBeirut,
    parseRange,
    parseMonth,
    monthOf,
    lastFullMonth,
    addMonths,
    monthBounds,
    monthsBetween,
} = require("./dates");
const { badRange } = require("./errors");
const { getAccountIds } = require("./accounts");
const { buildTenants } = require("./scope");
const M = require("./metrics");

// Financial report: POST /reports/v2/financial (plan §6.2, Phase 3).
//
// Profit and loss per shop (M1–M10), the profit split (M14, M15), the info lines that
// are not part of the split (M28 stock counts, M29 debt write-offs), the profit share of
// each user shop per month (owner decision S9), cash flow, the receivables movement and
// the expense list. Everything is put together here in integer cents; the client never
// adds money up.
//
// - Columns are 'combined' (Combined scope only) and String(database_id); the Combined
//   column is the cents sum of the tenant columns and carries no shares.
// - Shares use the CURRENT profit_share_pct (A4).
// - Restricted viewers (view_cost off, D8): the controller strips cost-derived keys and
//   the settlement, waterfall and purchases objects. Here the settlement and purchases
//   queries are skipped for them, and the cost-only notes are left out (D-P3-7).
//
// Profit share (S9, 2026-10-17): shares only. A user sends the admin almost all his cash
// and takes his share by keeping cash, so no transfer is read and no balance is kept.
// The section (the `settlement` key) lists, per user shop, the selected month and the
// months before it. From 2026-11 a kept share is recorded as "Share taken" and posted
// once the admin approves it (Phase 7.1): an SHR voucher, Dr 108 / Cr Cash or Whish,
// which the cash flow shows as its own class, shares_taken (never an expense or a
// correction; the P&L reads EXP vouchers only). The partner account itself is on the
// Balance sheet. shares_taken is a cash movement, not a cost figure: it is not stripped
// (D8; confirmed by the owner 2026-10-22, L1-7).
//
// Cash corrections with reasons (owner decisions C1–C4, 2026-10-22; plan §8 "Cash
// corrections with reasons"). The admin corrects his own till only (C2) with a reason
// that fixes the account and the voucher number: CAP (capital in, 101), DRW (owner
// drawings, 1081), CLS (unknown loss, 658), CGN (unknown gain, 758), SFO / SFI (moved to /
// back from the safe, 533). The cash flow shows each as its own class, tested right after
// SHR%; the legacy 'Manual Transaction' vouchers stay apart ("Corrections (old)",
// `old_corrections` since F4 below). Unknown loss and gain are part of the admin tenant's net profit (C1, M35):
// two P&L lines under expenses and two waterfall steps. Only his tenant can carry them, so
// the user splits, the profit-share months and the partner account are unchanged.
// Owner answer F4 (2026-10-22): the `corrections` class held two kinds, now two classes:
// `old_corrections`, the admin's old cash corrections (journal_number 'Manual
// Transaction', against 101; "Corrections (old)"), and `debt_corrections`, customer debt
// corrected through the till (Correct Debt with "Modify Cash": no number, description
// 'Manual Transaction', a 531 line beside the customer's 4111 line; any shop). Every line
// the old class held is in exactly one of them, so opening + flows = closing still holds;
// the key `corrections` is no longer sent (a client can tell the split by the new keys).
// The opening safe balance (F2, SOB, Dr 533 / Cr 101) has no till line: it is in no
// cash-flow class. The receivables movement keeps its own `corrections` class.

// Months listed per user shop: the selected month and the 5 before it
const SHARE_HISTORY_MONTHS = 6;

// The earliest settlement_month accepted: this many months before the current Beirut
// month (a fixed floor, so a bad month is refused before any SQL, whatever the scope)
const SETTLEMENT_MONTHS_BACK = 24;

/** The earliest settlement_month accepted at `now`, 'YYYY-MM'. */
const earliestSettlementMonth = (now = nowBeirut()) =>
    addMonths(monthOf(now), -SETTLEMENT_MONTHS_BACK);

const EXPENSE_ROWS = 200;

// Cash-flow classes of a tenant column, in display order; the Combined column replaces
// transfers_in / transfers_out with between_shops (their signed sum)
const FLOW_KEYS = [
    "cash_at_sale",
    "collections",
    "refunds",
    "expenses",
    "supplier_payments",
    "shares_taken",
    "transfers_in",
    "transfers_out",
    "self_transfer",
    // the admin's cash corrections with reasons (C1–C4); legacy ones stay in corrections
    "to_safe",
    "from_safe",
    "capital_in",
    "owner_drawings",
    "unknown_gain",
    "unknown_loss",
    // F4: the admin's old cash corrections, then customer debt corrected through the till
    "old_corrections",
    "debt_corrections",
    "other",
];
const RECEIVABLE_KEYS = [
    "credit_sales",
    "corrections",
    "collections",
    "returns_credited",
    "refunds",
    "other",
];

/**
 * Read the request body (contract §3.2): { from, to } through parseRange, and the
 * optional settlement_month, a 'YYYY-MM' from earliestSettlementMonth() up to the current
 * Beirut month (else 400 BAD_RANGE, field settlement_month). Checked before the scope is
 * resolved, so a bad body issues no SQL. Unknown keys are ignored.
 *
 * @returns {{ range: { from: string, to: string, lo: string, hi: string, days: number },
 *   settlementMonth: string|null }}
 */
function parseFinancialBody(body, now = nowBeirut()) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const range = parseRange(b);
    let settlementMonth = null;
    if (b.settlement_month !== undefined && b.settlement_month !== null) {
        settlementMonth = parseMonth(b.settlement_month, "settlement_month");
        if (settlementMonth > monthOf(now)) {
            throw badRange("settlement_month", "Pick a month up to the current one.");
        }
        if (settlementMonth < earliestSettlementMonth(now)) {
            throw badRange(
                "settlement_month",
                `Pick a month in the last ${SETTLEMENT_MONTHS_BACK} months.`,
            );
        }
    }
    return { range, settlementMonth };
}

// ---------------------------------------------------------------- page-only SQL

// M28: stock-count shortages (REMOVE) and surpluses (ADD other than the initial
// quantity), valued at the CURRENT unit cost (M17). Ledger stamps (LEDGER_CLOCK).
const STOCK_COUNTS_SQL = `/* rk:financial.stock_counts */
SELECT it.database_id,
  SUM(CASE WHEN it.transaction_type = 'REMOVE' THEN -it.quantity ELSE 0 END) AS shortages_units,
  ROUND(SUM(CASE WHEN it.transaction_type = 'REMOVE'
        THEN -it.quantity * COALESCE(NULLIF(i.avg_cost_usd,0), i.unit_cost_usd, 0) ELSE 0 END),2) AS shortages_value,
  SUM(CASE WHEN it.transaction_type = 'ADD' THEN it.quantity ELSE 0 END) AS surpluses_units,
  ROUND(SUM(CASE WHEN it.transaction_type = 'ADD'
        THEN it.quantity * COALESCE(NULLIF(i.avg_cost_usd,0), i.unit_cost_usd, 0) ELSE 0 END),2) AS surpluses_value
FROM inventory_transactions it
LEFT JOIN (SELECT MAX(record_id) rid, product_id_fk, database_id FROM inventory
           WHERE is_deleted = 0 AND database_id IN (?) GROUP BY product_id_fk, database_id) ix
       ON ix.product_id_fk = it.product_id_fk AND ix.database_id = it.database_id
LEFT JOIN inventory i ON i.record_id = ix.rid
WHERE it.database_id IN (?) AND it.is_deleted = 0
  AND (it.transaction_type = 'REMOVE'
       OR (it.transaction_type = 'ADD' AND COALESCE(it.transaction_notes,'') <> 'Initial Quantity'))
  AND it.transaction_datetime >= ? AND it.transaction_datetime < ?
GROUP BY it.database_id`;

// M29: the 4111 lines of Correct-debt vouchers whose counter line is capital (101). A
// correction through cash (531) is a collection, not a write-off (A8).
const WRITE_OFFS_SQL = `/* rk:financial.write_offs */
SELECT jv.database_id,
  ROUND(SUM(ji.credit),2) AS debt_written_off,
  ROUND(SUM(ji.debit),2) AS debt_added
FROM journal_vouchers jv
JOIN journal_items ji ON ji.journal_id_fk = jv.journal_id AND ji.is_deleted = 0 AND ji.account_id_fk = ?
WHERE jv.database_id IN (?) AND jv.is_deleted = 0
  AND jv.journal_description = 'Manual Transaction' AND jv.journal_number IS NULL
  AND jv.journal_date >= ? AND jv.journal_date < ?
  AND EXISTS (SELECT 1 FROM journal_items c WHERE c.journal_id_fk = jv.journal_id
              AND c.account_id_fk = ? AND c.is_deleted = 0)
GROUP BY jv.database_id`;

// Cash and whish movements by class (plan §6.2 D), keyed on ji.database_id like M20
// (a confirmed transfer's receiver line sits on the sender's voucher). Same filters as
// M20-AT, so opening + flows = closing. Corrections are tested before any description:
// a cash correction's description is the user's free text. Shares taken (Phase 7.1:
// SHR approval vouchers and their SHR…-R reversals, which net in the same class) are
// tested right after expenses, then the admin's corrections with reasons by their number
// prefix (2026-10-22; the description is a fixed label, but the number is what the writer
// controls), then the legacy corrections by their number 'Manual Transaction', then (F4)
// the Correct-debt vouchers by their description 'Manual Transaction' (no number).
const CASH_FLOW_SQL = `/* rk:financial.cash_flow */
SELECT ji.database_id, ji.account_id_fk,
  CASE WHEN jv.journal_number LIKE 'EXP%'                 THEN 'expenses'
       WHEN jv.journal_number LIKE 'SHR%'                 THEN 'shares_taken'
       WHEN jv.journal_number LIKE 'CAP%'                 THEN 'capital_in'
       WHEN jv.journal_number LIKE 'DRW%'                 THEN 'owner_drawings'
       WHEN jv.journal_number LIKE 'CLS%'                 THEN 'unknown_loss'
       WHEN jv.journal_number LIKE 'CGN%'                 THEN 'unknown_gain'
       WHEN jv.journal_number LIKE 'SFO%'                 THEN 'to_safe'
       WHEN jv.journal_number LIKE 'SFI%'                 THEN 'from_safe'
       WHEN jv.journal_number = 'Manual Transaction'      THEN 'old_corrections'
       WHEN jv.journal_description = 'Manual Transaction' THEN 'debt_corrections'
       WHEN jv.journal_description = 'Invoice'            THEN 'cash_at_sale'
       WHEN jv.journal_description = 'Payment Received'   THEN 'collections'
       WHEN jv.journal_description = 'Payment Returned'   THEN 'refunds'
       WHEN jv.journal_description = 'Supplier Payment'   THEN 'supplier_payments'
       WHEN jv.journal_description = 'Transfer'           THEN IF(ji.debit > 0, 'transfers_in', 'transfers_out')
       WHEN jv.journal_description = 'Self Transfer'      THEN 'self_transfer'
       ELSE 'other' END AS flow,
  ROUND(SUM(ji.debit - ji.credit),2) AS amount
FROM journal_items ji JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
WHERE ji.database_id IN (?) AND ji.is_deleted = 0 AND ji.account_id_fk IN (?, ?)
  AND jv.journal_date >= ? AND jv.journal_date < ?
GROUP BY ji.database_id, ji.account_id_fk, flow`;

// The net customer-balance movement by class (plan §6.2 E), over live customers' partner
// lines (S6) with the filters of M21, so opening + movements = closing
const RECEIVABLES_MOVE_SQL = `/* rk:financial.receivables_move */
SELECT jv.database_id,
  CASE WHEN jv.journal_number = 'Manual Transaction'
         OR jv.journal_description = 'Manual Transaction' THEN 'corrections'
       WHEN jv.journal_description = 'Invoice'            THEN 'credit_sales'
       WHEN jv.journal_description = 'Payment Received'   THEN 'collections'
       WHEN jv.journal_description = 'Return'             THEN 'returns_credited'
       WHEN jv.journal_description = 'Payment Returned'   THEN 'refunds'
       ELSE 'other' END AS class,
  ROUND(SUM(ji.debit - ji.credit),2) AS amount
FROM journal_items ji
JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk AND jv.is_deleted = 0
JOIN accounts a ON a.account_id = ji.partner_id_fk AND a.is_customer = 1 AND a.is_deleted = 0
WHERE jv.database_id IN (?) AND ji.is_deleted = 0
  AND jv.journal_date >= ? AND jv.journal_date < ?
GROUP BY jv.database_id, class`;

// The expense list (M9's vouchers), newest first
const EXPENSE_ROWS_SQL = `/* rk:financial.expense_rows */
SELECT jv.journal_id, jv.journal_number, jv.journal_date, jv.journal_description, jv.journal_notes,
       jv.total_value, jv.database_id
FROM journal_vouchers jv
WHERE jv.database_id IN (?) AND jv.is_deleted = 0 AND jv.journal_number LIKE 'EXP%'
  AND jv.journal_date >= ? AND jv.journal_date < ?
ORDER BY jv.journal_date DESC, jv.journal_id DESC
LIMIT ?`;

// Purchases at cost (admin only). purchase_orders.database_id is NULL on every row
// (PurchaseModel), so a purchase belongs to the admin tenant; the bind is that tenant.
const PURCHASES_SQL = `/* rk:financial.purchases */
SELECT ROUND(SUM(poi.quantity * poi.unit_cost_usd),2) AS purchased
FROM purchase_orders po
JOIN purchase_order_items poi ON poi.order_id_fk = po.order_id AND poi.is_deleted = 0
WHERE po.is_deleted = 0 AND (po.database_id IS NULL OR po.database_id IN (?))
  AND po.order_datetime >= ? AND po.order_datetime < ?`;

// Walk-in invoices paid with an amount other than their line total (addOrder does not
// check cash + whish = total)
const CASH_SALE_MISMATCH_SQL = `/* rk:financial.cash_sale_mismatch */
SELECT w.database_id, COUNT(*) AS n
FROM (SELECT so.database_id, so.order_id, so.journal_voucher_id,
             ROUND(SUM(soi.quantity * COALESCE(soi.unit_price,0)),2) AS total
      FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
      WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.customer_id IS NULL
        AND so.order_datetime >= ? AND so.order_datetime < ?
      GROUP BY so.database_id, so.order_id, so.journal_voucher_id) w
WHERE w.total <> COALESCE((SELECT ROUND(SUM(ji.debit),2) FROM journal_items ji
                           WHERE ji.journal_id_fk = w.journal_voucher_id AND ji.is_deleted = 0
                             AND ji.account_id_fk IN (?, ?)), 0)
GROUP BY w.database_id`;

const byTenant = (rows) => new Map(rows.map((r) => [Number(r.database_id), r]));

/** Map db → { shortages_units, shortages_c, surpluses_units, surpluses_c }. */
async function stockCounts(T, lo, hi) {
    const [rows] = await pool.query(STOCK_COUNTS_SQL, [T, T, lo, hi]);
    return new Map(
        rows.map((r) => [
            Number(r.database_id),
            {
                shortages_units: Number(r.shortages_units ?? 0),
                shortages_c: toCents(r.shortages_value),
                surpluses_units: Number(r.surpluses_units ?? 0),
                surpluses_c: toCents(r.surpluses_value),
            },
        ]),
    );
}

/** Map db → { written_off_c, added_c }. */
async function writeOffs(T, ids, lo, hi) {
    const [rows] = await pool.query(WRITE_OFFS_SQL, [ids.a4111, T, lo, hi, ids.a101]);
    return new Map(
        rows.map((r) => [
            Number(r.database_id),
            { written_off_c: toCents(r.debt_written_off), added_c: toCents(r.debt_added) },
        ]),
    );
}

/** Rows { database_id, account: 'cash'|'whish', flow, amount_c }. */
async function cashFlow(T, ids, lo, hi) {
    const [rows] = await pool.query(CASH_FLOW_SQL, [T, ids.a531, ids.a532, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        account: Number(r.account_id_fk) === ids.a531 ? "cash" : "whish",
        flow: String(r.flow),
        amount_c: toCents(r.amount),
    }));
}

/** Rows { database_id, kind, amount_c }. */
async function receivablesMove(T, lo, hi) {
    const [rows] = await pool.query(RECEIVABLES_MOVE_SQL, [T, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        kind: String(r.class),
        amount_c: toCents(r.amount),
    }));
}

async function expenseRows(T, lo, hi) {
    const [rows] = await pool.query(EXPENSE_ROWS_SQL, [T, lo, hi, EXPENSE_ROWS]);
    return rows.map((r) => {
        const notes = r.journal_notes == null ? null : String(r.journal_notes);
        return {
            journal_id: Number(r.journal_id),
            journal_number: String(r.journal_number),
            journal_date: r.journal_date,
            description: r.journal_description ?? null,
            money_account: notes === "531" || notes === "532" ? notes : null,
            amount: toMoney(toCents(r.total_value)),
            database_id: Number(r.database_id),
        };
    });
}

/** Purchases at cost in cents over [lo, hi), attributed to the admin tenant. */
async function purchases(adminDb, lo, hi) {
    const [rows] = await pool.query(PURCHASES_SQL, [[adminDb], lo, hi]);
    return toCents(rows[0]?.purchased ?? null);
}

/** Map db → walk-in invoices whose cash + whish paid ≠ their total. */
async function cashSaleMismatch(T, ids, lo, hi) {
    const [rows] = await pool.query(CASH_SALE_MISMATCH_SQL, [T, lo, hi, ids.a531, ids.a532]);
    return rows.reduce((n, r) => n + Number(r.n ?? 0), 0);
}

// ---------------------------------------------------------------- assembly helpers

const ZERO = {
    sales_c: 0,
    cogs_c: 0,
    returns_c: 0,
    rcost_c: 0,
    disposed_c: 0,
    expenses_c: 0,
    loss_c: 0,
    gain_c: 0,
};

/**
 * The M1–M10 components of one tenant (or month) from the metric rows. `x` is the
 * tenant's M35 row (unknown cash loss / gain): the admin tenant's only; absent → 0 (every
 * user column and every profit-share month).
 */
const componentsOf = (s, r, d, e, x) => ({
    sales_c: s ? s.sales_c : 0,
    cogs_c: s ? s.cogs_c : 0,
    returns_c: r ? r.returns_c : 0,
    rcost_c: r ? r.rcost_c : 0,
    disposed_c: d ? d.disposed_c : 0,
    expenses_c: e ? e.expenses_c : 0,
    loss_c: x ? x.loss_c : 0,
    gain_c: x ? x.gain_c : 0,
});

const addComponents = (list) => {
    const sum = { ...ZERO };
    for (const c of list) for (const k of Object.keys(sum)) sum[k] += c[k];
    return sum;
};

/**
 * The P&L in cents: net sales (M5), COGS net of returns, gross profit (M6), net profit
 * (M10 = M6 − M8 − M9 − unknown loss + unknown gain, C1).
 */
function pnlCents(c) {
    const net = c.sales_c - c.returns_c;
    const cogsNet = c.cogs_c - c.rcost_c;
    const gp = net - cogsNet;
    const afterExpenses = gp - c.disposed_c - c.expenses_c;
    return { ...c, net, cogsNet, gp, afterExpenses, np: afterExpenses - c.loss_c + c.gain_c };
}

const pnlColumn = (p) => ({
    sales: toMoney(p.sales_c),
    returns: toMoney(p.returns_c),
    net_sales: toMoney(p.net),
    cogs_net: toMoney(p.cogsNet),
    gross_profit: toMoney(p.gp),
    margin_pct: pct(p.gp, p.net),
    disposals: toMoney(p.disposed_c),
    expenses: toMoney(p.expenses_c),
    unknown_loss: toMoney(p.loss_c),
    unknown_gain: toMoney(p.gain_c),
    net_profit: toMoney(p.np),
});

/**
 * One month's split and S1 amount: the admin share of a profit, or the user's % of a loss
 * as a positive amount he owes the admin. Under S9 the page shows that amount only for a
 * loss month: in a profit month the user keeps his share out of the cash.
 */
function dueOf(npC, shareBp) {
    const split = splitShare(npC, shareBp);
    return {
        split,
        due: npC >= 0 ? split.admin : -split.user,
        direction: npC > 0 ? "admin_share" : npC < 0 ? "loss_share" : "none",
    };
}

const pair = (cashC, whishC) => ({
    cash: toMoney(cashC),
    whish: toMoney(whishC),
    total: toMoney(cashC + whishC),
});

const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);

/**
 * Build the Financial report of one scope.
 *
 * @param {object} args
 * @param {{ key: string, mode: 'combined'|'single', database_ids: number[] }} args.scope
 * @param {ReturnType<typeof parseFinancialBody>} args.params
 * @param {{ isAdmin: boolean, databaseId: number }} args.reports  req.reports
 * @param {Array} args.directory  scope.loadDirectory() rows
 * @param {boolean} args.restricted  view_cost off and not the admin
 * @param {moment.Moment} [args.now]  Beirut now (the same one the body was checked with)
 * @returns {Promise<{ payload: object,
 *   notes: Array<{code: string, count: number, value?: string}> }>}
 */
async function getFinancial({ scope, params, reports, directory, restricted, now = nowBeirut() }) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";
    const { lo, hi } = params.range;

    // The admin tenant: the admin caller's own (A11), else the tenant with an admin
    // login (the same rule as Inventory's admin prices). Every other tenant is a user.
    const adminDb = reports.isAdmin
        ? reports.databaseId
        : (directory.find((d) => d.has_admin)?.database_id ?? null);
    const tenants = new Map(buildTenants(directory, { reports }).map((t) => [t.database_id, t]));
    const dirById = new Map(directory.map((d) => [d.database_id, d]));
    const isUser = (t) => t !== adminDb;
    const userIds = T.filter(isUser);
    const shareOf = (t) => {
        const d = dirById.get(t);
        if (!d) throw new Error(`Tenant ${t} is not in the directory`);
        return asMoney(d.profit_share_pct);
    };

    // ---- the profit-share months (S9): the selected month, by default the last full
    // Beirut month (the current month is month-to-date), and the months before it, at
    // most SHARE_HISTORY_MONTHS in all and never before the earliest accepted month
    const current = monthOf(now);
    const defaultMonth = lastFullMonth(now);
    const earliest = earliestSettlementMonth(now);
    const month = params.settlementMonth ?? defaultMonth;
    const back = addMonths(month, 1 - SHARE_HISTORY_MONTHS);
    const firstMonth = back > earliest ? back : earliest;
    const sharesLo = monthBounds(firstMonth).lo;
    const sharesHi = monthBounds(month).hi;
    const settle = !restricted && userIds.length > 0;
    const withPurchases = !restricted && adminDb !== null && T.includes(adminDb);
    // M35 binds the admin tenant alone (C1, C2)
    const withCashDifferences = adminDb !== null && T.includes(adminDb);

    // Account ids are read once (cached 10 min), inside a query slot of the group below
    let idsPromise = null;
    const ids = () => (idsPromise ??= getAccountIds());

    // Never more than 4 queries at a time
    const [
        sales, returns, disposed, expensesSum, counts, written, cashAtRows, flowRows,
        recvAt, recvMove, expenseList, mismatch, pending, purchasedC,
        mSales, mReturns, mDisposed, mExpenses, cashDiffs,
    ] = await M.runLimited([
        () => M.salesTotals(T, lo, hi),
        () => M.returnsTotals(T, lo, hi),
        () => M.disposals(T, lo, hi),
        () => M.expenses(T, lo, hi),
        () => stockCounts(T, lo, hi),
        async () => writeOffs(T, await ids(), lo, hi),
        async () => M.cashAt(T, await ids(), lo, hi),
        async () => cashFlow(T, await ids(), lo, hi),
        () => M.receivablesAt(T, lo, hi),
        () => receivablesMove(T, lo, hi),
        () => expenseRows(T, lo, hi),
        async () => cashSaleMismatch(T, await ids(), lo, hi),
        () => M.pendingTransfers(T),
        withPurchases ? () => purchases(adminDb, lo, hi) : () => null,
        settle ? () => M.salesTotals(userIds, sharesLo, sharesHi, "%Y-%m") : () => [],
        settle ? () => M.returnsTotals(userIds, sharesLo, sharesHi, "%Y-%m") : () => [],
        settle ? () => M.disposals(userIds, sharesLo, sharesHi, "%Y-%m") : () => [],
        settle ? () => M.expenses(userIds, sharesLo, sharesHi, "%Y-%m") : () => [],
        withCashDifferences ? () => M.cashDifferences([adminDb], lo, hi) : () => [],
    ]);

    // ---- columns: Combined first (Combined scope), then the admin, then the users by
    // color_index (the admin's is 0)
    const colorOf = (t) => tenants.get(t)?.color_index ?? Number.MAX_SAFE_INTEGER;
    const ordered = [...T].sort((a, b) => colorOf(a) - colorOf(b) || a - b);
    const columns = [];
    if (combined) {
        columns.push({
            key: "combined",
            database_id: null,
            label: "Combined",
            role: "combined",
            active: true,
        });
    }
    for (const t of ordered) {
        const row = tenants.get(t);
        const d = dirById.get(t);
        columns.push({
            key: String(t),
            database_id: t,
            label: row ? row.name : String(d?.database_name ?? "").trim(),
            role: isUser(t) ? "user" : "admin",
            active: row ? row.active : Boolean(d?.has_admin || d?.has_live_user),
        });
    }

    // ---- P&L per tenant (M1–M10, M14), then Combined (M15)
    const S = byTenant(sales);
    const R = byTenant(returns);
    const D = byTenant(disposed);
    const E = byTenant(expensesSum);
    // M35: the admin tenant's row only (the statement binds no other tenant)
    const X = new Map(cashDiffs.filter((x) => x.database_id === adminDb).map((x) => [x.database_id, x]));
    const pnlBy = new Map(
        T.map((t) => [
            t,
            pnlCents(componentsOf(S.get(t), R.get(t), D.get(t), E.get(t), X.get(t))),
        ]),
    );
    const pnl = {};
    let userShareC = 0;
    let adminShareC = 0;
    for (const t of T) {
        const p = pnlBy.get(t);
        const col = pnlColumn(p);
        if (isUser(t)) {
            const share = shareOf(t);
            const split = splitShare(p.np, bp(share));
            col.share_pct = share;
            col.user_share = toMoney(split.user);
            col.admin_share = toMoney(split.admin);
            userShareC += split.user;
            adminShareC += split.admin;
        }
        pnl[String(t)] = col;
    }
    const totalP = pnlCents(addComponents([...pnlBy.values()]));
    let profit_split = null;
    if (combined) {
        pnl.combined = pnlColumn(totalP);
        const adminNp = adminDb !== null && pnlBy.has(adminDb) ? pnlBy.get(adminDb).np : 0;
        profit_split = {
            business_profit: toMoney(totalP.np),
            admin_keeps: toMoney(adminNp + adminShareC),
            users_share: toMoney(userShareC),
        };
    }

    // ---- info lines, never part of M10 (D1): M28 stock counts, M29 write-offs
    const infoCol = (list) => ({
        shortages_units: sum(list, (x) => x.c.shortages_units),
        shortages_cost: toMoney(sum(list, (x) => x.c.shortages_c)),
        surpluses_units: sum(list, (x) => x.c.surpluses_units),
        surpluses_cost: toMoney(sum(list, (x) => x.c.surpluses_c)),
        debt_written_off: toMoney(sum(list, (x) => x.w.written_off_c)),
        debt_added: toMoney(sum(list, (x) => x.w.added_c)),
    });
    const noCounts = { shortages_units: 0, shortages_c: 0, surpluses_units: 0, surpluses_c: 0 };
    const infoParts = T.map((t) => ({
        c: counts.get(t) || noCounts,
        w: written.get(t) || { written_off_c: 0, added_c: 0 },
    }));
    const info = {};
    if (combined) info.combined = infoCol(infoParts);
    T.forEach((t, i) => {
        info[String(t)] = infoCol([infoParts[i]]);
    });

    // ---- waterfall of the Combined column, or of the single column (D-P3-2, D-P3-5)
    const w = combined ? totalP : pnlBy.get(T[0]);
    const waterfall = {
        sales: toMoney(w.sales_c),
        returns: toMoney(w.returns_c),
        net_sales: toMoney(w.net),
        cogs_net: toMoney(w.cogsNet),
        gross_profit: toMoney(w.gp),
        disposals: toMoney(w.disposed_c),
        after_disposals: toMoney(w.gp - w.disposed_c),
        expenses: toMoney(w.expenses_c),
        after_expenses: toMoney(w.afterExpenses),
        unknown_loss: toMoney(w.loss_c),
        unknown_gain: toMoney(w.gain_c),
        net_profit: toMoney(w.np),
    };

    // ---- cash flow: opening + Σ flows = closing, per account (M20-AT, §6.2 D)
    const flowCells = new Map(); // `${db}|${flow}` → { cash_c, whish_c }
    for (const r of flowRows) {
        const k = `${r.database_id}|${r.flow}`;
        const c = flowCells.get(k) || { cash_c: 0, whish_c: 0 };
        c[`${r.account}_c`] += r.amount_c;
        flowCells.set(k, c);
    }
    const flowOf = (t, f) => flowCells.get(`${t}|${f}`) || { cash_c: 0, whish_c: 0 };
    const atOf = (t) =>
        cashAtRows.get(t) || { open: { cash_c: 0, whish_c: 0 }, close: { cash_c: 0, whish_c: 0 } };
    const pendingSum = (list) => sum(list, (p) => p.amount_c);
    const pendingOut = (t) => pendingSum(pending.filter((p) => p.from_database_id === t));
    const pendingIn = (t) => pendingSum(pending.filter((p) => p.to_database_id === t));

    const cash_flow = {};
    if (combined) {
        const flows = {};
        for (const f of FLOW_KEYS) {
            if (f === "transfers_out") continue;
            const keys = f === "transfers_in" ? ["transfers_in", "transfers_out"] : [f];
            const name = f === "transfers_in" ? "between_shops" : f;
            let c = 0;
            let wh = 0;
            for (const t of T) {
                for (const k of keys) {
                    c += flowOf(t, k).cash_c;
                    wh += flowOf(t, k).whish_c;
                }
            }
            flows[name] = pair(c, wh);
        }
        const atSum = (side) =>
            pair(sum(T, (t) => atOf(t)[side].cash_c), sum(T, (t) => atOf(t)[side].whish_c));
        const col = {
            opening: atSum("open"),
            closing: atSum("close"),
            flows,
            // every pending transfer once, whichever side of it is in T
            cash_in_transit: toMoney(pendingSum(pending)),
        };
        if (withPurchases) col.purchases = toMoney(purchasedC);
        cash_flow.combined = col;
    }
    for (const t of T) {
        const at = atOf(t);
        const flows = {};
        for (const f of FLOW_KEYS) flows[f] = pair(flowOf(t, f).cash_c, flowOf(t, f).whish_c);
        const col = {
            opening: pair(at.open.cash_c, at.open.whish_c),
            closing: pair(at.close.cash_c, at.close.whish_c),
            flows,
            transfers_pending_out: toMoney(pendingOut(t)),
            transfers_pending_in: toMoney(pendingIn(t)),
        };
        if (withPurchases && t === adminDb) col.purchases = toMoney(purchasedC);
        cash_flow[String(t)] = col;
    }

    // ---- receivables movement: opening + movements = closing (M21 at :lo / :hi, §6.2 E)
    const moveCells = new Map(); // `${db}|${kind}` → cents
    for (const r of recvMove) {
        const k = `${r.database_id}|${r.kind}`;
        moveCells.set(k, (moveCells.get(k) || 0) + r.amount_c);
    }
    const empty = { net_c: 0, receivables_c: 0, credits_c: 0, debtors: 0 };
    const recCol = (list) => {
        const out = { opening: toMoney(sum(list, (t) => (recvAt.get(t)?.open ?? empty).net_c)) };
        for (const k of RECEIVABLE_KEYS) {
            out[k] = toMoney(sum(list, (t) => moveCells.get(`${t}|${k}`) || 0));
        }
        const close = (f) => sum(list, (t) => (recvAt.get(t)?.close ?? empty)[f]);
        out.closing = toMoney(close("net_c"));
        out.closing_receivables = toMoney(close("receivables_c"));
        out.closing_customer_credits = toMoney(close("credits_c"));
        out.debtors = close("debtors");
        return out;
    };
    const receivables = {};
    if (combined) receivables.combined = recCol(T);
    for (const t of T) receivables[String(t)] = recCol([t]);

    // ---- expenses: count and total over the whole range (M9), the newest 200 rows
    const expenses = {
        count: sum(expensesSum, (e) => e.count),
        total: toMoney(sum(expensesSum, (e) => e.expenses_c)),
        rows: expenseList,
    };

    // ---- profit share (S9; D4, A4, S1): per user shop, in tenant (chip) order, each
    // month computed on its own (no carry-forward), no transfers and no balance
    const users = [];
    if (settle) {
        const cellKey = (t, m) => `${t}|${m}`;
        const index = (rows) => new Map(rows.map((r) => [cellKey(r.database_id, r.bucket), r]));
        const mS = index(mSales);
        const mR = index(mReturns);
        const mD = index(mDisposed);
        const mE = index(mExpenses);
        const months = monthsBetween(firstMonth, month);

        for (const u of ordered.filter(isUser)) {
            const share = shareOf(u);
            const shareBp = bp(share);
            users.push({
                database_id: u,
                share_pct: share,
                months: months.map((m) => {
                    const k = cellKey(u, m);
                    const c = componentsOf(mS.get(k), mR.get(k), mD.get(k), mE.get(k));
                    const np = pnlCents(c).np;
                    const { split, due, direction } = dueOf(np, shareBp);
                    return {
                        month: m,
                        net_profit: toMoney(np),
                        share_pct: share,
                        user_share: toMoney(split.user),
                        admin_share: toMoney(split.admin),
                        settlement_due: toMoney(due),
                        direction,
                        in_progress: m === current,
                    };
                }),
            });
        }
    }
    const settlement = {
        month,
        default_month: defaultMonth,
        earliest_month: earliest,
        in_progress: month === current,
        users,
    };

    // ---- notes (plan §9)
    const notes = [];
    const note = (code, count, extra = {}) => {
        if (count > 0) notes.push({ code, count, ...extra });
    };
    if (combined) {
        note(
            "INACTIVE_INCLUDED",
            T.filter((t) => {
                const d = dirById.get(t);
                return d && !(d.has_admin || d.has_live_user);
            }).length,
        );
    }
    if (!restricted) {
        note("COST_FALLBACK_LINES", sum(sales, (s) => s.fallback_lines));
        note("RETURN_COST_CURRENT_AVG", sum(returns, (r) => r.returns_count) > 0 ? 1 : 0);
    }
    note("CASH_SALE_MISMATCH", mismatch);
    note("PENDING_TRANSFERS", pending.length, { value: toMoney(pendingSum(pending)) });
    note("LEDGER_CLOCK", 1);
    note("ORPHAN_PAYMENTS", 1);
    note("PAYMENT_DATE_EDITS", 1);
    note("SHORTAGES_NOT_IN_SPLIT", 1);
    // C1: the admin's unknown cash losses and gains in the range are part of his net
    // profit, unlike stock-count shortages (info only, D1)
    note("CASH_DIFFERENCES_IN_PROFIT", sum(cashDiffs, (x) => (x.database_id === adminDb ? x.count : 0)));
    if (!restricted) note("SHARE_KEPT_UNRECORDED", settlement.users.length > 0 ? 1 : 0);

    const payload = { columns, pnl };
    if (profit_split) payload.profit_split = profit_split;
    payload.info = info;
    payload.waterfall = waterfall;
    payload.settlement = settlement;
    payload.cash_flow = cash_flow;
    payload.receivables = receivables;
    payload.expenses = expenses;

    return { payload, notes };
}

module.exports = {
    SHARE_HISTORY_MONTHS,
    SETTLEMENT_MONTHS_BACK,
    earliestSettlementMonth,
    parseFinancialBody,
    getFinancial,
};
