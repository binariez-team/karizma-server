const moment = require("moment-timezone");
const pool = require("../../config/database");
const { toMoney, asMoney, toCents, bp } = require("./money");
const { getAccountIds } = require("./accounts");
const { buildTenants } = require("./scope");
const { bounds, nowBeirut, monthOf } = require("./dates");
const { badRange } = require("./errors");
const M = require("./metrics");
const P = require("./partner");

// Balance sheet: POST /reports/v2/balance-sheet (plan §6.7, Phase 4; month ends §8
// Phase 7 item 2).
//
// What each shop holds and owes NOW (D16), or at a past month end (as_of), and the
// assets-cap use of each user's shop (M30, D6, D7). Every figure comes from the canonical
// metrics, so it equals Inventory (stock, deliveries, exposure) and Financial (cash,
// receivables, pending transfers) to the cent. Everything is put together here in integer
// cents; the client never adds money up.
//
// - Assets: Cash and Whish (M20, signed), customer receivables (M21 positive part, live
//   customers, S6), stock at cost (M18, deleted products out, S7), deliveries awaiting
//   approval INTO the shop (M24), transfers awaiting confirmation INTO the shop (M25, A6)
//   and supplier advances (M22 negative part). Liabilities: supplier payables (M22
//   positive part) and customer credits (M21 negative part). Net position = assets −
//   liabilities. Supplier lines count live suppliers only, as the Suppliers screen (S10).
// - Cash outside the till (M36, owner decision C3, 2026-10-22): the balance of 533, the
//   business money the admin moved out of the till into the safe, the bank or his hands
//   (his to_safe / from_safe corrections), plus the opening safe balance he records once
//   (SOB, owner answer F2, 2026-10-22). Its own asset line `cash_outside_till` (the
//   admin's column and Combined; "0.00" on a user's, which cannot carry it), in total
//   assets and net position; `cash` and `whish` stay the till only (M20, = GET /balance),
//   and the cap use (M30) never counts it. At a month end it is cut by voucher date.
// - Every in-transit item belongs to its receiver: the sender already shows it as gone
//   (stock left at dispatch, the transfer was credited at once). So the Combined column is
//   the cents sum of the tenant columns, inactive tenants included. A tenant column's
//   `info` lists what it sent that is still awaiting the other side; it is in no total.
// - Sale value (M19) uses the admin's prices where a user shop has none (S5).
// - Nothing records a stock or delivery posting in the accounts, so there is no
//   books-balance check (NO_BOOKS_CHECK).
// - Partner account (Phase 7.1 part G, PA11): each user column owes its user his untaken
//   profit share (M33 = earned M31 − taken M32, partner.js, signed), a liability line
//   `untaken_profit_share` ("0.00" on the admin's column, the sum on Combined).
//   total_liabilities stays payables + customer credits; total_liabilities_incl_profit_share
//   adds the share, and net position = assets − that (a user column's net position is
//   then the admin's money in the shop). The cap use (M30) subtracts the same share
//   (O6), and profit_share_account lists earned, taken, untaken, money held for the
//   admin (M34) and the months, per user shop. A share is counted as taken once the
//   admin approves it (an SHR voucher on 108); until it is recorded and approved a kept
//   share is still in the recorded cash (KEPT_SHARE_IN_CASH) and in the untaken share,
//   so the cap use and M34 are right either way (part B).
// - Restricted viewers (view_cost off, D8): the controller strips the cost keys
//   (stock_cost, pending_in_cost, pending_out_cost, total_assets, net_position, the
//   exposure figures, and every profit-share key through the regex). Here the notes
//   that only explain cost figures are left out (D-P2-7, D-P3-7), and the partner
//   statements are not run for them.
//
// Month end (as_of = a month's last day that has a month-end snapshot, D-P7.2). The
// same lines, columns, exposure and notes, built from figures as of that month end:
// - stock from inventory_cost_snapshots (the 23:55 run of that day): quantity × the
//   recorded cost (M17's chain on the snapshot's avg / unit cost), sale values from the
//   snapshot's prices with the S5 fallback (a user row's 0 / NULL price takes the
//   admin's price from the same snapshot, or his current price when he held none of it
//   then); products flagged product_deleted in the snapshot are out (S7);
// - cash, Whish (M20-AT), customer balances (M21 cut) and supplier balances (M22 cut)
//   from the journal by voucher date, before the next day's 00:00;
// - deliveries dispatched before that cut and still unapproved at it (approved_at at
//   or after it). An approved order with no approved_at was approved before the
//   column was written (§7.2, before the snapshot job shipped), so before any month
//   end on offer: it counts as approved;
// - transfers dated before the cut and still unconfirmed: a later confirmation is
//   dated on the transfer's own voucher, so it is already in the receiver's cash;
// - a snapshot taken after its month ended (taken_at's day after snapshot_date) is
//   flagged approximate;
// - exposure: the same M30 call on the month-end segments, against today's cap (caps
//   keep no history);
// - partner account: earned through as_of's month, taken by voucher date before the cut
//   (M32 < cut), no pending entries (they are now-view information);
// - cash outside the till (M36) by voucher date before the cut.
// The list of month ends (as_of.month_ends) is global, not per scope: a shop holding
// no stock at a month end has no snapshot row, yet its month end exists.

// Month ends are read from the snapshot table's primary key alone (an index-only
// read); forced --now runs are stamped with their own day, so only last days are kept
// (in JS).
const MONTH_ENDS_SQL = `/* rk:balance_sheet.month_ends */
SELECT DISTINCT snapshot_date FROM inventory_cost_snapshots ORDER BY snapshot_date DESC`;

// The month-end stock of T, one row per (tenant, live product) recorded by the snapshot.
// sa: the admin tenant's row of the same product in the same snapshot (his prices at
// the time); ax / ai: his latest live inventory row now (the S5 rule), for a product he
// held none of at the month end. Both bind the admin tenant, not T (as D-P2-8).
const SNAPSHOT_STOCK_SQL = `/* rk:balance_sheet.snapshot_stock */
SELECT s.database_id, s.product_id, s.quantity,
       COALESCE(NULLIF(s.avg_cost_usd,0), s.unit_cost_usd, 0) AS unit_cost,
       s.unit_price_usd, s.whole_price_usd, s.grandwhole_price_usd, s.taken_at,
       sa.product_id AS admin_snapshot_product,
       sa.unit_price_usd AS snap_admin_unit_price_usd, sa.whole_price_usd AS snap_admin_whole_price_usd,
       sa.grandwhole_price_usd AS snap_admin_grandwhole_price_usd,
       ai.unit_price_usd AS admin_unit_price_usd, ai.whole_price_usd AS admin_whole_price_usd,
       ai.grandwhole_price_usd AS admin_grandwhole_price_usd
FROM inventory_cost_snapshots s
LEFT JOIN inventory_cost_snapshots sa
       ON sa.snapshot_date = s.snapshot_date AND sa.database_id IN (?) AND sa.product_id = s.product_id
LEFT JOIN (SELECT MAX(record_id) AS rid, product_id_fk FROM inventory
           WHERE is_deleted = 0 AND database_id IN (?) GROUP BY product_id_fk) ax
       ON ax.product_id_fk = s.product_id
LEFT JOIN inventory ai ON ai.record_id = ax.rid
WHERE s.snapshot_date = ? AND s.database_id IN (?) AND s.product_deleted = 0`;

// M23 lines as of the cut: dispatched before it, not deleted, and not approved before
// it. Same value chain and S7 rule as metrics.pending_lines.
const PENDING_LINES_AT_SQL = `/* rk:balance_sheet.pending_lines_at */
SELECT d.order_id, d.database_id AS receiver_id, d.admin_id_fk AS sender_id,
       di.product_id, di.quantity AS units,
       ROUND(di.quantity * COALESCE(NULLIF(di.avg_cost_usd,0), NULLIF(si.avg_cost_usd,0),
                                    NULLIF(si.unit_cost_usd,0), di.unit_price), 2) AS value_cost,
       (di.avg_cost_usd IS NULL) AS legacy_line
FROM deliver_orders d
JOIN deliver_order_items di ON di.order_id_fk = d.order_id AND di.is_deleted = 0
JOIN products p ON p.product_id = di.product_id AND p.is_deleted = 0
LEFT JOIN (SELECT MAX(record_id) rid, product_id_fk, database_id FROM inventory
           WHERE is_deleted = 0 GROUP BY product_id_fk, database_id) sx
       ON sx.product_id_fk = di.product_id AND sx.database_id = d.admin_id_fk
LEFT JOIN inventory si ON si.record_id = sx.rid
WHERE d.is_deleted = 0 AND d.order_datetime < ? AND (d.is_approved = 0 OR d.approved_at >= ?)
  AND (d.database_id IN (?) OR d.admin_id_fk IN (?))`;

// M22 per supplier as of the cut (by voucher date; lines filtered as M22: ji.is_deleted
// only; live suppliers only, S10)
const SUPPLIER_BALANCES_AT_SQL = `/* rk:balance_sheet.supplier_balances_at */
SELECT ji.database_id, ji.partner_id_fk, ROUND(SUM(ji.credit - ji.debit),2) AS bal
FROM journal_items ji
JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
JOIN accounts a ON a.account_id = ji.partner_id_fk AND a.is_supplier = 1 AND a.is_deleted = 0
WHERE ji.database_id IN (?) AND ji.is_deleted = 0 AND jv.journal_date < ?
GROUP BY ji.database_id, ji.partner_id_fk`;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const flag = (v) => Boolean(Number(v));

/** A 'YYYY-MM-DD' that is the last day of its month (a calendar day: no time zone). */
const isMonthEndDay = (value) => {
    if (typeof value !== "string" || !DAY_RE.test(value)) return false;
    const m = moment.tz(value, "YYYY-MM-DD", true, "UTC");
    return m.isValid() && m.clone().add(1, "day").date() === 1;
};

/**
 * The body: the scope (read by the controller) and `as_of`. Absent, null or 'now' →
 * as of now; else a month's last day ('YYYY-MM-DD', 2000–2099), whose snapshot is
 * checked by getBalanceSheet. Anything else ("" included, as settlement_month,
 * D-P3-S4) → 400 BAD_RANGE, field as_of, before any SQL. Other keys are ignored.
 *
 * @returns {{ asOf: string|null }}
 */
function parseBalanceSheetBody(body) {
    const raw = body?.as_of;
    if (raw === undefined || raw === null || raw === "now") return { asOf: null };
    if (!isMonthEndDay(raw) || raw < "2000-01-01" || raw > "2099-12-31") {
        throw badRange("as_of", "Pick a month end.");
    }
    return { asOf: raw };
}

/**
 * The month ends that have a snapshot, newest first ('YYYY-MM-DD'). [] when the
 * snapshot table is missing (§7.4 not run yet), so the page still answers as of now.
 */
async function listMonthEnds() {
    let rows;
    try {
        [rows] = await pool.query(MONTH_ENDS_SQL);
    } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") return [];
        throw error;
    }
    return rows.map((r) => String(r.snapshot_date).slice(0, 10)).filter(isMonthEndDay);
}

/**
 * M19 price per unit of a snapshot row, in cents (S5): a user row's 0 / NULL price
 * takes the admin's price from the same snapshot when he had a row of the product,
 * else his current price; the admin's own rows never fall back.
 */
function snapshotPrice(own, adminThen, adminNow, hadRow, mayFallBack) {
    const c = toCents(own);
    if (c !== 0 || !mayFallBack) return { c, fallback: false };
    const a = toCents(hadRow ? adminThen : adminNow);
    return { c: a, fallback: a !== 0 };
}

/** The month-end stock of T, shaped as metrics.liveBase rows (plus taken_at). */
async function snapshotStock(date, T, adminDb) {
    const admin = [adminDb ?? 0]; // 0 matches no tenant
    const [rows] = await pool.query(SNAPSHOT_STOCK_SQL, [admin, admin, date, T]);
    return rows.map((r) => {
        const db = Number(r.database_id);
        const mayFallBack = adminDb !== null && adminDb !== undefined && db !== adminDb;
        const hadRow = r.admin_snapshot_product !== null && r.admin_snapshot_product !== undefined;
        const price = (basis) =>
            snapshotPrice(
                r[`${basis}_price_usd`],
                r[`snap_admin_${basis}_price_usd`],
                r[`admin_${basis}_price_usd`],
                hadRow,
                mayFallBack,
            );
        const retail = price("unit");
        const wholesale = price("whole");
        const grand = price("grandwhole");
        return {
            database_id: db,
            product_id: Number(r.product_id),
            on_hand: Number(r.quantity),
            unit_cost_c: toCents(r.unit_cost),
            retail_c: retail.c,
            wholesale_c: wholesale.c,
            grand_c: grand.c,
            admin_priced: retail.fallback || wholesale.fallback || grand.fallback,
            taken_at: r.taken_at === null || r.taken_at === undefined ? null : String(r.taken_at),
        };
    });
}

/** Lines of the deliveries T sent or received that were in transit at the cut. */
async function pendingLinesAt(T, cut) {
    const [rows] = await pool.query(PENDING_LINES_AT_SQL, [cut, cut, T, T]);
    return rows.map((r) => ({
        order_id: Number(r.order_id),
        receiver_id: Number(r.receiver_id),
        sender_id: Number(r.sender_id),
        product_id: Number(r.product_id),
        units: Number(r.units),
        value_c: toCents(r.value_cost),
        legacy: flag(r.legacy_line),
    }));
}

/** metrics.supplierBalances as of the cut: Map db → { payables_c, advances_c }. */
async function supplierBalancesAt(T, cut) {
    const [rows] = await pool.query(SUPPLIER_BALANCES_AT_SQL, [T, cut]);
    const byTenant = new Map();
    for (const r of rows) {
        const db = Number(r.database_id);
        let t = byTenant.get(db);
        if (!t) {
            t = { payables_c: 0, advances_c: 0 };
            byTenant.set(db, t);
        }
        const bal = toCents(r.bal);
        if (bal > 0) t.payables_c += bal;
        else if (bal < 0) t.advances_c -= bal;
    }
    return byTenant;
}

/** The closing side of metrics.cashAt / receivablesAt (Map db → { open, close }). */
const closing = (byTenant) => new Map([...byTenant].map(([db, x]) => [db, x.close]));

const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);

// Exposure rows with the same rounded % keep the order of their status (and colour):
// the status is set on exact cents, the % is rounded to 1 decimal (80.0 can be 'ok')
const STATUS_RANK = { over: 2, warn: 1, ok: 0 };

const zeroStock = () => ({
    cost: 0,
    retail: 0,
    wholesale: 0,
    grand: 0,
    units: 0,
    negative: 0,
    zeroCost: 0,
    adminPriced: 0,
    zeroPrice: 0,
});

/**
 * Build the Balance sheet of one scope.
 *
 * @param {object} args
 * @param {{ key: string, mode: 'combined'|'single', database_ids: number[] }} args.scope
 * @param {{ asOf: string|null }} [args.params]  parseBalanceSheetBody()
 * @param {{ isAdmin: boolean, databaseId: number }} args.reports  req.reports
 * @param {Array} args.directory  scope.loadDirectory() rows
 * @param {boolean} args.restricted  view_cost off and not the admin
 * @param {moment.Moment} [args.now]  Beirut now (the partner account's current month)
 * @returns {Promise<{ payload: object,
 *   notes: Array<{code: string, count: number, value?: string, database_id?: number}> }>}
 */
async function getBalanceSheet({
    scope,
    params = {},
    reports,
    directory,
    restricted,
    now = nowBeirut(),
}) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";

    // The month ends on offer; a month end without a snapshot is refused before any
    // other statement
    const monthEnds = await listMonthEnds();
    const asOf = params.asOf ?? null;
    if (asOf !== null && !monthEnds.includes(asOf)) {
        throw badRange("as_of", `There is no month-end snapshot for ${asOf}.`);
    }
    // the next day's 00:00 (Beirut wall clock, as every stored date)
    const cut = asOf === null ? null : bounds(asOf, asOf).hi;

    // The admin tenant: the admin caller's own (A11), else the tenant with an admin login
    // (the rule of Inventory's admin prices and of Financial). Every other tenant is a
    // user, a tenant missing from the directory included (cap null).
    const adminDb = reports.isAdmin
        ? reports.databaseId
        : (directory.find((d) => d.has_admin)?.database_id ?? null);
    const tenants = new Map(buildTenants(directory, { reports }).map((t) => [t.database_id, t]));
    const dirById = new Map(directory.map((d) => [d.database_id, d]));
    const isUser = (t) => t !== adminDb;
    // The whole shop: the balance sheet has no product filter
    const filter = M.filterSql({});

    // Account ids are read once (cached 10 min; re-read while 108 is missing, PA15)
    let idsPromise = null;
    const ids = () => (idsPromise ??= getAccountIds());

    // Partner account (Phase 7.1): the user shops of T, for a viewer who may see cost
    // and profit (the D-P3-S8 pattern: restricted viewers would only have it stripped).
    // L is the current Beirut month, or as_of's month at a month end.
    const userIds = T.filter(isUser);
    const partnerOn = !restricted && userIds.length > 0;
    const lastMonth = asOf === null ? monthOf(now) : asOf.slice(0, 7);
    const withPending = asOf === null;
    const partnerThunks = partnerOn
        ? P.partnerThunks(userIds, { lastMonth, ids, withPending })
        : [];

    // Never more than 4 queries at a time; the account ids are read inside the cash
    // slot. Both modes hand back the same shapes; the partner thunks come last.
    const results =
        asOf === null
            ? await M.runLimited([
                  () => M.liveBase(T, filter, adminDb),
                  () => M.pendingLines(T, filter),
                  async () => M.cashWhish(T, await ids()),
                  () => M.receivables(T),
                  () => M.pendingTransfers(T),
                  () => M.supplierBalances(T),
                  async () => M.outsideTill(T, await ids()),
                  ...partnerThunks,
              ])
            : await M.runLimited([
                  () => snapshotStock(asOf, T, adminDb),
                  () => pendingLinesAt(T, cut),
                  async () => closing(await M.cashAt(T, await ids(), cut, cut)),
                  async () => closing(await M.receivablesAt(T, cut, cut)),
                  async () =>
                      (await M.pendingTransfers(T)).filter(
                          (x) => String(x.transfer_datetime) < cut,
                      ),
                  () => supplierBalancesAt(T, cut),
                  async () => M.outsideTill(T, await ids(), cut),
                  ...partnerThunks,
              ]);
    const [base, lines, cash, recv, transfers, suppliers, outside] = results;

    // M31–M33 per user shop (zeros before the start month, PA15 zeros before §7.7)
    const shareBp = (t) => bp(asMoney(dirById.get(t)?.profit_share_pct) ?? "0.00");
    const partner = partnerOn
        ? P.partnerFold(results.slice(7), userIds, shareBp, {
              now,
              lastMonth,
              withPending,
              monthEnd: asOf !== null,
          })
        : { byTenant: new Map(), notSetUp: false };
    const accountOf = (t) => partner.byTenant.get(t) || P.emptyAccount(withPending);

    // Month end: when the scope's stock was recorded; after the month's last day it is
    // approximate (a shop with no stock then has no row: nothing to approximate)
    const takenAt =
        asOf === null
            ? null
            : base.reduce((max, r) => (r.taken_at && (!max || r.taken_at > max) ? r.taken_at : max), null);
    const as_of = {
        mode: asOf === null ? "now" : "month_end",
        date: asOf,
        taken_at: takenAt,
        approximate: takenAt !== null && takenAt.slice(0, 10) > asOf,
        month_ends: monthEnds,
    };

    // ---- stock per tenant (M18, M19): value is max(on_hand, 0) × price; a negative row
    // adds nothing and is counted (NEGATIVE_STOCK)
    const stock = new Map(T.map((t) => [t, zeroStock()]));
    for (const r of base) {
        const s = stock.get(r.database_id);
        if (!s) continue;
        const qty = Math.max(r.on_hand, 0);
        s.cost += qty * r.unit_cost_c;
        s.retail += qty * r.retail_c;
        s.wholesale += qty * r.wholesale_c;
        s.grand += qty * r.grand_c;
        s.units += qty;
        if (r.on_hand < 0) s.negative += 1;
        if (r.on_hand > 0 && r.unit_cost_c === 0) s.zeroCost += 1;
        if (r.on_hand > 0 && r.admin_priced) s.adminPriced += 1;
        if (r.on_hand > 0 && (r.retail_c === 0 || r.wholesale_c === 0 || r.grand_c === 0)) {
            s.zeroPrice += 1;
        }
    }

    // ---- deliveries awaiting approval (M23 lines): in by receiver (M24), out by sender
    const pendingOf = (side, t) => {
        const own = lines.filter((l) => l[side] === t);
        return { units: sum(own, (l) => l.units), value_c: sum(own, (l) => l.value_c) };
    };
    // ---- transfers awaiting confirmation (M25): in by receiver (A6), out by sender
    const transferOf = (side, t) => sum(transfers.filter((x) => x[side] === t), (x) => x.amount_c);

    // ---- one column per tenant, in cents
    const byTenant = new Map();
    for (const t of T) {
        const s = stock.get(t);
        const pin = pendingOf("receiver_id", t);
        const pout = pendingOf("sender_id", t);
        const c = cash.get(t) || { cash_c: 0, whish_c: 0 };
        const rc = recv.get(t) || { receivables_c: 0, credits_c: 0 };
        const sp = suppliers.get(t) || { payables_c: 0, advances_c: 0 };
        byTenant.set(t, {
            cash: c.cash_c,
            whish: c.whish_c,
            // M36: 533, the admin's safe; 0 for a tenant with no line on it
            cash_outside_till: outside.get(t) ?? 0,
            receivables: rc.receivables_c,
            stock_cost: s.cost,
            stock_units: s.units,
            pending_in_cost: pin.value_c,
            pending_in_units: pin.units,
            transfers_pending_in: transferOf("to_database_id", t),
            supplier_advances: sp.advances_c,
            supplier_payables: sp.payables_c,
            customer_credits: rc.credits_c,
            retail: s.retail,
            wholesale: s.wholesale,
            grand: s.grand,
            transfers_pending_out: transferOf("from_database_id", t),
            pending_out_cost: pout.value_c,
            pending_out_units: pout.units,
            // M33: owed to the user; 0 on the admin's column and when not computed
            untaken_profit_share: isUser(t) ? accountOf(t).untaken_c : 0,
        });
    }

    const ASSET_MONEY = [
        "cash",
        "whish",
        "cash_outside_till",
        "receivables",
        "stock_cost",
        "pending_in_cost",
        "transfers_pending_in",
        "supplier_advances",
    ];
    const column = (c, withInfo) => {
        const assets = sum(ASSET_MONEY, (k) => c[k]);
        const liabilities = c.supplier_payables + c.customer_credits;
        // PA11 (confirmed by the owner, L1-4): the untaken share is a liability of the shop
        const liabilitiesInclShare = liabilities + c.untaken_profit_share;
        const col = {
            assets: {
                cash: toMoney(c.cash),
                whish: toMoney(c.whish),
                cash_outside_till: toMoney(c.cash_outside_till),
                receivables: toMoney(c.receivables),
                stock_cost: toMoney(c.stock_cost),
                stock_units: c.stock_units,
                pending_in_cost: toMoney(c.pending_in_cost),
                pending_in_units: c.pending_in_units,
                transfers_pending_in: toMoney(c.transfers_pending_in),
                supplier_advances: toMoney(c.supplier_advances),
            },
            liabilities: {
                supplier_payables: toMoney(c.supplier_payables),
                customer_credits: toMoney(c.customer_credits),
                untaken_profit_share: toMoney(c.untaken_profit_share),
            },
            total_assets: toMoney(assets),
            total_liabilities: toMoney(liabilities),
            total_liabilities_incl_profit_share: toMoney(liabilitiesInclShare),
            net_position: toMoney(assets - liabilitiesInclShare),
            stock_sale_value: {
                retail: toMoney(c.retail),
                wholesale: toMoney(c.wholesale),
                grand: toMoney(c.grand),
            },
        };
        if (withInfo) {
            col.info = {
                transfers_pending_out: toMoney(c.transfers_pending_out),
                pending_out_cost: toMoney(c.pending_out_cost),
                pending_out_units: c.pending_out_units,
            };
        }
        return col;
    };

    // ---- columns: Combined first (Combined scope), then the admin, then the users by
    // color_index (the admin's is 0); the same list as Financial's
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

    const by_col = {};
    if (combined) {
        const total = {};
        for (const k of Object.keys(byTenant.get(T[0]))) {
            total[k] = sum(T, (t) => byTenant.get(t)[k]);
        }
        by_col.combined = column(total, false);
    }
    for (const t of ordered) by_col[String(t)] = column(byTenant.get(t), true);

    // ---- assets cap of each user's shop (M30): the whole shop, signed cash, less the
    // user's untaken profit share (Phase 7.1, O6); pending transfers (A6) and customer
    // credits (D7) are not part of it. The admin's own shop has no row. At a month end
    // the segments (and the untaken share) are that month end's and the cap is today's
    // (no cap history); one call for both modes.
    const exposure = ordered
        .filter(isUser)
        .map((t) => {
            const c = byTenant.get(t);
            const cap = dirById.get(t)?.assets_cap_usd ?? null;
            const e = M.exposureDetail({
                cash_c: c.cash,
                whish_c: c.whish,
                receivables_c: c.receivables,
                stock_c: c.stock_cost,
                pending_in_c: c.pending_in_cost,
                untaken_c: c.untaken_profit_share,
                cap,
            });
            return {
                row: {
                    database_id: t,
                    assets_cap_usd: asMoney(cap),
                    cash: toMoney(c.cash),
                    whish: toMoney(c.whish),
                    receivables: toMoney(c.receivables),
                    stock_cost: toMoney(c.stock_cost),
                    pending_in_cost: toMoney(c.pending_in_cost),
                    ...e,
                },
                // a cap of 0.00 has no percentage; no cap sorts by the amount held
                group: e.exposure_pct !== null ? 0 : cap !== null ? 1 : 2,
                used_c: toCents(e.exposure_used),
                color: colorOf(t),
            };
        })
        .sort(
            (a, b) =>
                a.group - b.group ||
                (a.group === 0 ? b.row.exposure_pct - a.row.exposure_pct : 0) ||
                (a.group === 0
                    ? STATUS_RANK[b.row.exposure_status] - STATUS_RANK[a.row.exposure_status]
                    : 0) ||
                (a.group === 1
                    ? (b.row.exposure_status === "over") - (a.row.exposure_status === "over")
                    : 0) ||
                (a.group === 2 ? b.used_c - a.used_c : 0) ||
                a.color - b.color ||
                a.row.database_id - b.row.database_id,
        )
        .map((x) => x.row);

    // ---- partner account per user shop (Phase 7.1 part G), in chip order; [] on the
    // admin's chip and for the admin's staff. M34 held for the admin = cash + whish +
    // receivables − customer credits + stock at cost − untaken (O4); deliveries awaiting
    // approval are shown beside it (pending_in_cost), not in it.
    let profitShareAccount = null;
    if (!restricted) {
        profitShareAccount = {
            start_month: P.PARTNER_START_MONTH,
            through_month: lastMonth,
            in_progress: asOf === null,
            users: ordered.filter(isUser).map((t) => {
                const c = byTenant.get(t);
                const a = accountOf(t);
                return {
                    database_id: t,
                    share_pct: asMoney(dirById.get(t)?.profit_share_pct ?? null),
                    earned_profit_share: toMoney(a.earned_c),
                    taken_profit_share: toMoney(a.taken_c),
                    untaken_profit_share: toMoney(a.untaken_c),
                    pending_count: a.pending_count,
                    pending_amount: a.pending_c === null ? null : toMoney(a.pending_c),
                    held_for_admin_cost: toMoney(
                        c.cash +
                            c.whish +
                            c.receivables -
                            c.customer_credits +
                            c.stock_cost -
                            a.untaken_c,
                    ),
                    pending_in_cost: toMoney(c.pending_in_cost),
                    months: a.months.map(P.monthRow),
                };
            }),
        };
    }

    // ---- notes (plan §9): INACTIVE_INCLUDED first, then the contract's table order
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
    note("NEGATIVE_STOCK", sum(T, (t) => stock.get(t).negative));
    // in stock with no cost recorded, so valued at $0 (as Inventory; cost-only, D-P2-7)
    if (!restricted) note("ZERO_COST_STOCK", sum(T, (t) => stock.get(t).zeroCost));
    // S5: rows in stock valued at the admin's prices, one note per shop (as Inventory)
    for (const t of T) {
        note("ADMIN_PRICE_FALLBACK", stock.get(t).adminPriced, { database_id: t });
    }
    note("ZERO_PRICE_STOCK", sum(T, (t) => stock.get(t).zeroPrice));
    if (!restricted) {
        note(
            "LEGACY_DELIVERY_SNAPSHOT",
            new Set(lines.filter((l) => l.legacy).map((l) => l.order_id)).size,
        );
    }
    note("PENDING_TRANSFERS", transfers.length, {
        value: toMoney(sum(transfers, (x) => x.amount_c)),
    });
    if (!restricted) {
        // worded by the page from as_of: today's average now, the snapshot's at a month
        // end, and from which month end values exist (§9)
        note("NO_COST_HISTORY", 1);
        // A kept share stays in the recorded cash until it is recorded and approved
        note("KEPT_SHARE_IN_CASH", T.some(isUser) ? 1 : 0);
        // Partner account (Phase 7.1): shares count from the start month (O3, A4)
        note("PARTNER_START", profitShareAccount.users.length > 0 ? 1 : 0);
        if (withPending) {
            const users = profitShareAccount.users;
            note(
                "PARTNER_SHARES_PENDING",
                sum(users, (u) => u.pending_count ?? 0),
                { value: toMoney(sum(userIds, (t) => accountOf(t).pending_c ?? 0)) },
            );
        }
    }
    // Before §7.7 (PA15): taken and pending read 0; the admin is told why (also before
    // the start month, from the chart ids the cash slot already read)
    if (reports.isAdmin && partnerOn && (partner.notSetUp || (await ids()).a108 === null)) {
        note("PARTNER_NOT_SET_UP", 1);
    }
    note("NO_BOOKS_CHECK", 1);

    const payload = { as_of, columns, by_col, exposure };
    if (profitShareAccount) payload.profit_share_account = profitShareAccount;
    return { payload, notes };
}

module.exports = { parseBalanceSheetBody, getBalanceSheet };
