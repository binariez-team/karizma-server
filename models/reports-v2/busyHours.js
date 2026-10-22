const pool = require("../../config/database");
const { toCents, toMoney } = require("./money");
const { parseRange } = require("./dates");

// Busy hours: POST /reports/v2/busy-hours (plan §6.5, Phase 6).
//
// When the shops sell, by weekday and hour of the day, over a date range: orders, sales
// and gross profit per (weekday, hour) cell, per weekday, per hour and in total, and in
// Combined each shop's peak time. Every figure is put together here in integer cents;
// the client never adds money up.
//
// - Sales lines only (F_S: M1, M11, and M1 − M2 for the gross profit). Returns are
//   excluded (§6.5). Sales come from the lines, never the header total; a line's cost is
//   the LINE_COST chain (the avg-cost snapshot, else the line's unit cost), as Overview.
// - A sale's cell is WEEKDAY() (0 = Monday … 6 = Sunday) and HOUR() of
//   so.order_datetime, the Beirut wall clock at entry. A backdated invoice keeps the
//   chosen date with the time it was entered (SellOrdersModel.addOrder), and an edit
//   keeps it: note BACKDATED_HOUR, always.
// - One statement, grouped by tenant, weekday and hour. An invoice belongs to one tenant
//   and one cell, so adding the tenants' distinct order counts up is exact (Combined
//   cells, by weekday, by hour, totals).
// - Restricted viewers (view_cost off, D8): the controller strips every gross_profit.
//   The peaks rank by orders, then sales, never by cost, and the cost-only note
//   COST_FALLBACK_LINES is left out.

/**
 * Read the request body: { from, to } through parseRange. Checked before the scope is
 * resolved, so a bad body issues no SQL. Unknown keys (the page's metric toggle, if a
 * client sends it) are ignored.
 *
 * @returns {{ range: { from: string, to: string, lo: string, hi: string, days: number } }}
 */
function parseBusyHoursBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    return { range: parseRange(b) };
}

// F_S over [lo, hi) per (tenant, weekday, hour). gross_profit is §6.5's expression:
// quantities are INT and prices / costs DECIMAL(10,2), so it equals sales − LINE_COST to
// the cent. fallback_lines counts the lines costed at last cost (COST_FALLBACK_LINES);
// it never goes into the payload.
const CELLS_SQL = `/* rk:busy_hours.cells */
SELECT so.database_id, WEEKDAY(so.order_datetime) AS dow, HOUR(so.order_datetime) AS hr,
       COUNT(DISTINCT so.order_id) AS orders,
       ROUND(SUM(soi.quantity * COALESCE(soi.unit_price,0)),2) AS sales,
       ROUND(SUM(soi.quantity * (COALESCE(soi.unit_price,0) - COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0))),2) AS gross_profit,
       SUM(COALESCE(soi.avg_cost,0) = 0) AS fallback_lines
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?
GROUP BY so.database_id, dow, hr`;

/** The non-empty cells of T over [lo, hi), per tenant, in cents. */
async function cellRows(T, lo, hi) {
    const [rows] = await pool.query(CELLS_SQL, [T, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        dow: Number(r.dow),
        hour: Number(r.hr),
        orders: Number(r.orders ?? 0),
        sales_c: toCents(r.sales),
        gp_c: toCents(r.gross_profit),
        fallback_lines: Number(r.fallback_lines ?? 0),
    }));
}

const zero = () => ({ orders: 0, sales_c: 0, gp_c: 0 });
const add = (acc, r) => {
    acc.orders += r.orders;
    acc.sales_c += r.sales_c;
    acc.gp_c += r.gp_c;
    return acc;
};
const figures = (a) => ({
    orders: a.orders,
    sales: toMoney(a.sales_c),
    gross_profit: toMoney(a.gp_c),
});

// A shop's peak: the cell with the most orders, then the most sales, then the earliest
// weekday and hour (so a tie always gives the same answer)
const busier = (a, b) =>
    b.orders - a.orders || b.sales_c - a.sales_c || a.dow - b.dow || a.hour - b.hour;

/**
 * Build the Busy hours page of one scope.
 *
 * @param {object} args
 * @param {{ key: string, mode: 'combined'|'single', database_ids: number[] }} args.scope
 * @param {ReturnType<typeof parseBusyHoursBody>} args.params
 * @param {{ isAdmin: boolean, databaseId: number }} args.reports
 * @param {Array} args.directory  scope.loadDirectory() rows
 * @param {boolean} args.restricted  view_cost off and not the admin
 * @returns {Promise<{ payload: object, notes: Array<{code: string, count: number}> }>}
 */
async function getBusyHours({ scope, params, reports, directory, restricted }) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";
    const { lo, hi } = params.range;

    const rows = await cellRows(T, lo, hi);

    // ---- the scope's cells (Combined: the cents sum of the tenants' cells), by weekday,
    // by hour and in total; by_dow and by_hour are zero-filled, cells non-empty only
    const cellMap = new Map(); // dow * 24 + hour → sums
    const byDow = Array.from({ length: 7 }, zero);
    const byHour = Array.from({ length: 24 }, zero);
    const total = zero();
    const perTenant = new Map(T.map((t) => [t, { sum: zero(), cells: [] }]));
    let fallbackLines = 0;

    for (const r of rows) {
        const k = r.dow * 24 + r.hour;
        if (!cellMap.has(k)) cellMap.set(k, { dow: r.dow, hour: r.hour, ...zero() });
        add(cellMap.get(k), r);
        add(byDow[r.dow], r);
        add(byHour[r.hour], r);
        add(total, r);
        const t = perTenant.get(r.database_id);
        if (t) {
            add(t.sum, r);
            t.cells.push(r);
        }
        fallbackLines += r.fallback_lines;
    }

    const cells = [...cellMap.values()]
        .sort((a, b) => a.dow - b.dow || a.hour - b.hour)
        .map((c) => ({ dow: c.dow, hour: c.hour, ...figures(c) }));

    const by_tenant = {};
    for (const t of T) by_tenant[String(t)] = figures(perTenant.get(t).sum);

    // ---- Combined: each shop's busiest cell, one row per tenant of T (inactive ones
    // included; the client filters), in chip order: the admin's shop first, then by
    // database_id. A shop without a sale in the range has no peak (nulls, 0 orders).
    let peaks = null;
    if (combined) {
        const adminDb = reports.isAdmin ? reports.databaseId : null;
        peaks = [...T]
            .sort((a, b) => (b === adminDb) - (a === adminDb) || a - b)
            .map((t) => {
                const [top] = [...perTenant.get(t).cells].sort(busier);
                return {
                    database_id: t,
                    busiest_dow: top ? top.dow : null,
                    busiest_hour: top ? top.hour : null,
                    orders: top ? top.orders : 0,
                };
            });
    }

    // ---- notes (plan §9): inactive shops first (as every page), then the contract's
    // order
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
    if (!restricted) note("COST_FALLBACK_LINES", fallbackLines);
    note("BACKDATED_HOUR", 1);

    const payload = {
        cells,
        by_dow: byDow.map((a, dow) => ({ dow, ...figures(a) })),
        by_hour: byHour.map((a, hour) => ({ hour, ...figures(a) })),
        totals: figures(total),
        by_tenant,
    };
    if (peaks) payload.peaks = peaks;

    return { payload, notes };
}

module.exports = { parseBusyHoursBody, getBusyHours };
