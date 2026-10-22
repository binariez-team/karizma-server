const pool = require("../../config/database");
const { bool } = require("./validate");
const { toCents, toMoney, pct, roundHalfAway } = require("./money");
const { parseRange, granularity, previousWindow, bucketKeys } = require("./dates");
const M = require("./metrics");

// Sales overview: POST /reports/v2/overview (plan §6.1, Phase 3).
//
// Sales, returns, orders and trends over a date range. Every figure is put together
// here in integer cents from the canonical metrics (M1–M7, M11–M13); the client never
// adds money up.
//
// - The scope total is the cents sum of the tenants; ratios (margin, AOV, shares,
//   rates) are recomputed from the summed parts, never averaged.
// - Returns count on their own document date: the trend subtracts them by
//   ro.order_datetime, so the chart and the tiles agree.
// - Restricted viewers (view_cost off, D8): the controller strips every cost-derived
//   key (cogs, returns_cost, gross_profit, margin_pct, profit). Rankings never use cost
//   (invoices by total, products by net sales), so nothing leaks through the order, and
//   the cost-only note COST_FALLBACK_LINES is left out.

const TOP_DOCS = 10; // largest invoices, largest returns
const TOP_PRODUCTS = 5;

/**
 * Read the request body (contract §3.1): { from, to } through parseRange, `compare`
 * strictly boolean. Checked before the scope is resolved, so a bad body issues no SQL.
 * Unknown keys are ignored.
 *
 * @returns {{ range: { from: string, to: string, lo: string, hi: string, days: number },
 *   compare: boolean }}
 */
function parseOverviewBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const range = parseRange(b);
    const compare = bool(b.compare, "compare");
    return { range, compare };
}

// ---------------------------------------------------------------- page-only SQL

// The 10 largest invoices by line total (never by cost); the profit is total − LINE_COST.
const LARGEST_INVOICES_SQL = `/* rk:overview.largest_invoices */
SELECT so.order_id, so.invoice_number, so.database_id, so.order_datetime, a.name AS customer_name,
       ROUND(SUM(soi.quantity * COALESCE(soi.unit_price,0)),2) AS total,
       ROUND(SUM(soi.quantity * COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0)),2) AS line_cost
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
LEFT JOIN accounts a ON a.account_id = so.customer_id
WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?
GROUP BY so.order_id, so.invoice_number, so.database_id, so.order_datetime, a.name
ORDER BY total DESC, so.order_id
LIMIT ?`;

// The 10 largest returns (a return always has a customer, return_orders.customer_id is
// NOT NULL); total > 0 only
const LARGEST_RETURNS_SQL = `/* rk:overview.largest_returns */
SELECT ro.order_id, ro.invoice_number, ro.database_id, ro.order_datetime, a.name AS customer_name,
       ROUND(SUM(roi.quantity * COALESCE(roi.unit_price,0)),2) AS total,
       ROUND(SUM(roi.quantity * COALESCE(NULLIF(roi.avg_cost,0), roi.unit_cost, 0)),2) AS line_cost
FROM return_orders ro JOIN return_order_items roi ON roi.order_id = ro.order_id AND roi.is_deleted = 0
LEFT JOIN accounts a ON a.account_id = ro.customer_id
WHERE ro.database_id IN (?) AND ro.is_deleted = 0 AND ro.order_datetime >= ? AND ro.order_datetime < ?
GROUP BY ro.order_id, ro.invoice_number, ro.database_id, ro.order_datetime, a.name
HAVING total > 0
ORDER BY total DESC, ro.order_id
LIMIT ?`;

// Per product over all of T, sales and returns separately (a product may only have
// returns in the range); merged into net figures in cents below
const PRODUCT_SALES_SQL = `/* rk:overview.product_sales */
SELECT soi.product_id, p.product_name, SUM(soi.quantity) AS qty,
       ROUND(SUM(soi.quantity * COALESCE(soi.unit_price,0)),2) AS amount,
       ROUND(SUM(soi.quantity * COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0)),2) AS line_cost
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
LEFT JOIN products p ON p.product_id = soi.product_id
WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?
GROUP BY soi.product_id, p.product_name`;

const PRODUCT_RETURNS_SQL = `/* rk:overview.product_returns */
SELECT roi.product_id, p.product_name, SUM(roi.quantity) AS qty,
       ROUND(SUM(roi.quantity * COALESCE(roi.unit_price,0)),2) AS amount,
       ROUND(SUM(roi.quantity * COALESCE(NULLIF(roi.avg_cost,0), roi.unit_cost, 0)),2) AS line_cost
FROM return_orders ro JOIN return_order_items roi ON roi.order_id = ro.order_id AND roi.is_deleted = 0
LEFT JOIN products p ON p.product_id = roi.product_id
WHERE ro.database_id IN (?) AND ro.is_deleted = 0 AND ro.order_datetime >= ? AND ro.order_datetime < ?
GROUP BY roi.product_id, p.product_name`;

const docRows = (rows, isReturn) =>
    rows.map((r) => {
        const total = toCents(r.total);
        const margin = total - toCents(r.line_cost);
        return {
            order_id: Number(r.order_id),
            invoice_number: r.invoice_number ?? null,
            database_id: Number(r.database_id),
            customer_name: r.customer_name ?? null,
            datetime: r.order_datetime,
            total: toMoney(total),
            // a return gives its profit back: negative (D-P3-4)
            profit: toMoney(isReturn ? -margin : margin),
        };
    });

async function largestDocs(sql, T, lo, hi, isReturn) {
    const [rows] = await pool.query(sql, [T, lo, hi, TOP_DOCS]);
    return docRows(rows, isReturn);
}

/** Map product_id → { name, qty, amount_c, cost_c }. */
async function productLines(sql, T, lo, hi) {
    const [rows] = await pool.query(sql, [T, lo, hi]);
    return new Map(
        rows
            .filter((r) => r.product_id !== null && r.product_id !== undefined)
            .map((r) => [
                Number(r.product_id),
                {
                    name: r.product_name ?? null,
                    qty: Number(r.qty ?? 0),
                    amount_c: toCents(r.amount),
                    cost_c: toCents(r.line_cost),
                },
            ]),
    );
}

// ---------------------------------------------------------------- assembly helpers

const ZERO_SALES = {
    orders: 0,
    units_sold: 0,
    sales_c: 0,
    cogs_c: 0,
    cash_sales_c: 0,
    customers_served: 0,
    fallback_lines: 0,
};
const ZERO_RETURNS = { returns_count: 0, units_returned: 0, returns_c: 0, rcost_c: 0 };

/** The summed parts of several tenants (cents and counts). */
function addParts(list) {
    const sum = { ...ZERO_SALES, ...ZERO_RETURNS };
    for (const p of list) for (const k of Object.keys(sum)) sum[k] += p[k];
    return sum;
}

/** AOV in cents (M12), rounded half away from zero; null without orders. */
const aovOf = (salesC, orders) => (orders > 0 ? roundHalfAway(salesC / orders) : null);

/** OvTotals (contract §3.1) from summed parts. */
function totalsOf(p) {
    const net = p.sales_c - p.returns_c;
    const gp = p.sales_c - p.cogs_c - (p.returns_c - p.rcost_c);
    const aov = aovOf(p.sales_c, p.orders);
    return {
        sales: toMoney(p.sales_c),
        returns: toMoney(p.returns_c),
        net_sales: toMoney(net),
        cogs: toMoney(p.cogs_c),
        returns_cost: toMoney(p.rcost_c),
        gross_profit: toMoney(gp),
        margin_pct: pct(gp, net),
        orders: p.orders,
        aov: aov === null ? null : toMoney(aov),
        units_sold: p.units_sold,
        units_returned: p.units_returned,
        units_net: p.units_sold - p.units_returned,
        cash_sales: toMoney(p.cash_sales_c),
        credit_sales: toMoney(p.sales_c - p.cash_sales_c),
        cash_share_pct: pct(p.cash_sales_c, p.sales_c),
        return_rate_pct: pct(p.returns_c, p.sales_c),
        returns_count: p.returns_count,
        customers_served: p.customers_served,
    };
}

/** Per tenant parts, every id of T zero-filled, from the two totals queries. */
function partsByTenant(T, sales, returns) {
    const s = new Map(sales.map((r) => [r.database_id, r]));
    const r = new Map(returns.map((x) => [x.database_id, x]));
    return new Map(
        T.map((t) => [t, { ...ZERO_SALES, ...s.get(t), ...ZERO_RETURNS, ...r.get(t) }]),
    );
}

// Delta of one OvTotals key (D-P3-1): money and counts as % change against |prev|,
// percentages as the percentage-point difference. 1 decimal, rounded half away from
// zero; null when there is nothing to compare with.
function deltaOf(key, cur, prev) {
    if (cur === null || prev === null || cur === undefined || prev === undefined) return null;
    if (key.endsWith("_pct")) {
        return roundHalfAway(cur * 10 - prev * 10) / 10;
    }
    const c = typeof cur === "string" ? toCents(cur) : cur;
    const p = typeof prev === "string" ? toCents(prev) : prev;
    if (p === 0) return null;
    return roundHalfAway(((c - p) * 1000) / Math.abs(p)) / 10;
}

const nameOf = (p) => String(p.product_name ?? "");

// Ties of the product ranking: name (case- and accent-insensitive), then id
const byName = (a, b) =>
    nameOf(a).localeCompare(nameOf(b), "en", { sensitivity: "base" }) ||
    a.product_id - b.product_id;

/**
 * Build the Sales overview of one scope.
 *
 * @param {object} args
 * @param {{ key: string, mode: 'combined'|'single', database_ids: number[] }} args.scope
 * @param {ReturnType<typeof parseOverviewBody>} args.params
 * @param {Array} args.directory  scope.loadDirectory() rows
 * @param {boolean} args.restricted  view_cost off and not the admin
 * @returns {Promise<{ payload: object, notes: Array<{code: string, count: number}> }>}
 */
async function getOverview({ scope, params, directory, restricted }) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";
    const { from, to, lo, hi } = params.range;
    const gran = granularity(from, to);
    const prev = params.compare ? previousWindow(from, to) : null;

    // Never more than 4 queries at a time
    const [
        sales, returns, salesB, returnsB, invoices, returnDocs, prodSales, prodReturns,
        prevSales, prevReturns,
    ] = await M.runLimited([
        () => M.salesTotals(T, lo, hi),
        () => M.returnsTotals(T, lo, hi),
        () => M.salesTotals(T, lo, hi, gran.sql),
        () => M.returnsTotals(T, lo, hi, gran.sql),
        () => largestDocs(LARGEST_INVOICES_SQL, T, lo, hi, false),
        () => largestDocs(LARGEST_RETURNS_SQL, T, lo, hi, true),
        () => productLines(PRODUCT_SALES_SQL, T, lo, hi),
        () => productLines(PRODUCT_RETURNS_SQL, T, lo, hi),
        prev ? () => M.salesTotals(T, prev.lo, prev.hi) : () => [],
        prev ? () => M.returnsTotals(T, prev.lo, prev.hi) : () => [],
    ]);

    // ---- totals per tenant, then the scope total (the cents sum of the tenants)
    const parts = partsByTenant(T, sales, returns);
    const totalParts = addParts([...parts.values()]);
    const by_tenant = {};
    for (const t of T) by_tenant[String(t)] = totalsOf(parts.get(t));
    const total = totalsOf(totalParts);

    // ---- compare: the window of the same length just before
    let previous = null;
    let deltas = null;
    if (prev) {
        const prevParts = partsByTenant(T, prevSales, prevReturns);
        const prevBy = {};
        for (const t of T) prevBy[String(t)] = totalsOf(prevParts.get(t));
        const prevTotal = totalsOf(addParts([...prevParts.values()]));
        previous = { range: { from: prev.from, to: prev.to }, total: prevTotal, by_tenant: prevBy };
        deltas = {};
        for (const k of Object.keys(total)) deltas[k] = deltaOf(k, total[k], prevTotal[k]);
    }

    // ---- trend: net sales and gross profit per bucket and tenant, zero-filled
    const cells = new Map(); // `${bucket}|${db}` → { net_c, gp_c }
    const cell = (bucket, db) => {
        const k = `${bucket}|${db}`;
        if (!cells.has(k)) cells.set(k, { net_c: 0, gp_c: 0 });
        return cells.get(k);
    };
    for (const r of salesB) {
        const c = cell(r.bucket, r.database_id);
        c.net_c += r.sales_c;
        c.gp_c += r.sales_c - r.cogs_c;
    }
    for (const r of returnsB) {
        const c = cell(r.bucket, r.database_id);
        c.net_c -= r.returns_c;
        c.gp_c -= r.returns_c - r.rcost_c;
    }
    const buckets = bucketKeys(from, to, gran.unit).map((key) => {
        let net = 0;
        let gp = 0;
        const byT = {};
        for (const t of T) {
            const c = cells.get(`${key}|${t}`) || { net_c: 0, gp_c: 0 };
            net += c.net_c;
            gp += c.gp_c;
            byT[String(t)] = { net_sales: toMoney(c.net_c), gross_profit: toMoney(c.gp_c) };
        }
        return { key, net_sales: toMoney(net), gross_profit: toMoney(gp), by_tenant: byT };
    });

    // ---- top products over all of T: net sales > 0, by net sales, then name
    const products = [];
    for (const id of new Set([...prodSales.keys(), ...prodReturns.keys()])) {
        const s = prodSales.get(id) || { name: null, qty: 0, amount_c: 0, cost_c: 0 };
        const r = prodReturns.get(id) || { name: null, qty: 0, amount_c: 0, cost_c: 0 };
        const net = s.amount_c - r.amount_c;
        if (net <= 0) continue;
        products.push({
            product_id: id,
            product_name: s.name ?? r.name ?? "",
            net_c: net,
            net_qty: s.qty - r.qty,
            gp_c: s.amount_c - s.cost_c - (r.amount_c - r.cost_c),
        });
    }
    products.sort((a, b) => b.net_c - a.net_c || byName(a, b));
    const top_products = products.slice(0, TOP_PRODUCTS).map((p) => ({
        product_id: p.product_id,
        product_name: p.product_name,
        net_qty: p.net_qty,
        net_sales: toMoney(p.net_c),
        gross_profit: toMoney(p.gp_c),
    }));

    // ---- By shop (Combined): every tenant of T, by net sales, then database_id
    let by_shop = null;
    if (combined) {
        const totalNet = totalParts.sales_c - totalParts.returns_c;
        by_shop = [...T]
            .map((t) => {
                const p = parts.get(t);
                const net = p.sales_c - p.returns_c;
                const gp = p.sales_c - p.cogs_c - (p.returns_c - p.rcost_c);
                const aov = aovOf(p.sales_c, p.orders);
                return {
                    database_id: t,
                    net_c: net,
                    row: {
                        database_id: t,
                        net_sales: toMoney(net),
                        gross_profit: toMoney(gp),
                        margin_pct: pct(gp, net),
                        orders: p.orders,
                        aov: aov === null ? null : toMoney(aov),
                        net_sales_share_pct: pct(net, totalNet),
                    },
                };
            })
            .sort((a, b) => b.net_c - a.net_c || a.database_id - b.database_id)
            .map((x) => x.row);
    }

    // ---- notes (plan §9)
    const notes = [];
    const note = (code, count) => {
        if (count > 0) notes.push({ code, count });
    };
    if (combined) {
        const dirById = new Map(directory.map((d) => [d.database_id, d]));
        note(
            "INACTIVE_INCLUDED",
            T.filter((t) => {
                const d = dirById.get(t);
                return d && !(d.has_admin || d.has_live_user);
            }).length,
        );
    }
    if (!restricted) note("COST_FALLBACK_LINES", totalParts.fallback_lines);

    const payload = { total, by_tenant };
    if (previous) {
        payload.previous = previous;
        payload.deltas = deltas;
    }
    payload.trend = { granularity: gran.unit, buckets };
    payload.largest_invoices = invoices;
    payload.largest_returns = returnDocs;
    payload.top_products = top_products;
    if (by_shop) payload.by_shop = by_shop;

    return { payload, notes };
}

module.exports = { parseOverviewBody, getOverview };
