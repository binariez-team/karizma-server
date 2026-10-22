const pool = require("../../config/database");
const validate = require("./validate");
const { toCents, toMoney, pct } = require("./money");
const { parseRange } = require("./dates");
const M = require("./metrics");

// Products: POST /reports/v2/products/table and /products/rollup (plan §6.3, Phase 5).
//
// Sales, returns and gross profit per product over a date range, server-paged, plus the
// same figures rolled up by category and by brand. Every figure is put together here in
// integer cents from the sale and return lines (M1–M7); the client never adds money up.
//
// - The lines are F_S and F_R as one UNION ALL (LINES_UNION). Each line's cost is the
//   LINE_COST chain (the avg-cost snapshot, else the line's unit cost); a return is
//   costed at the shop's average on the day of the return (RETURN_COST_CURRENT_AVG).
// - Deleted products keep their sales history (D10; the client tags them "deleted"),
//   but their stock counts nowhere (S7): on_hand and stock_cost are null for them.
// - on_hand and stock_cost are current figures (M16–M18), not figures of the range.
// - Sort and order map through constant objects; LIMIT and OFFSET are bound.
// - Restricted viewers (view_cost off, D8): the controller strips cogs_net,
//   gross_profit, margin_pct and stock_cost. Here a cost-based sort falls back to
//   net_sales (echoed in params.sort) and the cost-only notes are left out.

const SORTS = [
    "net_sales",
    "net_qty",
    "qty_sold",
    "qty_returned",
    "gross_profit",
    "margin_pct",
    "product_name",
    "on_hand",
];
const COST_SORTS = new Set(["gross_profit", "margin_pct"]);

/**
 * Read the table request (contract §3.2): the range, then search, category_id,
 * brand_id, sort, order, offset and limit. Checked before the scope is resolved, so a
 * bad body issues no SQL. Unknown keys are ignored; "" counts as absent.
 *
 * @returns {{ range: object, search: string|null, pattern: string|null,
 *   categoryId: number|null, brandId: number|null, sort: string, order: 'asc'|'desc',
 *   offset: number, limit: number }}
 */
function parseProductsTableBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const range = parseRange(b);
    const pattern = validate.search(b.search);
    return {
        range,
        // echoed back trimmed; the SQL only ever sees the escaped pattern
        search: pattern === null ? null : b.search.trim(),
        pattern,
        categoryId: validate.int(b.category_id, "category_id", { min: 1, def: null }),
        brandId: validate.int(b.brand_id, "brand_id", { min: 1, def: null }),
        sort: validate.enumOf(b.sort, "sort", SORTS, { def: "net_sales" }),
        order: validate.enumOf(b.order, "order", ["asc", "desc"], { def: "desc" }),
        offset: validate.offset(b.offset),
        limit: validate.limit(b.limit, { max: 200, def: 25 }),
    };
}

/** Read the rollup request (contract §3.3): the range only; the table filters do not apply. */
function parseProductsRollupBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    return { range: parseRange(b) };
}

// ---------------------------------------------------------------- SQL

// F_S and F_R lines as one set (plan §6.3 SQL core): qs / qr units sold / returned, rs /
// rr their value, cs / cr their cost (LINE_COST / RLINE_COST), fb a sale line costed at
// last cost (COST_FALLBACK_LINES). Binds: [T, lo, hi, (ids,) T, lo, hi (, ids)]. With
// `ids`, both arms keep only those products. Also used by productHistory.js.
const LINES_UNION = (ids) => `
  SELECT soi.product_id, so.database_id, soi.quantity AS qs, 0 AS qr,
         soi.quantity * COALESCE(soi.unit_price,0) AS rs, 0 AS rr,
         soi.quantity * COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0) AS cs, 0 AS cr,
         (COALESCE(soi.avg_cost,0) = 0) AS fb
  FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
  WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?${ids ? " AND soi.product_id IN (?)" : ""}
  UNION ALL
  SELECT roi.product_id, ro.database_id, 0, roi.quantity, 0, roi.quantity * COALESCE(roi.unit_price,0),
         0, roi.quantity * COALESCE(NULLIF(roi.avg_cost,0), roi.unit_cost, 0), 0
  FROM return_orders ro JOIN return_order_items roi ON roi.order_id = ro.order_id AND roi.is_deleted = 0
  WHERE ro.database_id IN (?) AND ro.is_deleted = 0 AND ro.order_datetime >= ? AND ro.order_datetime < ?${ids ? " AND roi.product_id IN (?)" : ""}`;

/** The LINES_UNION binds, in placeholder order. */
const unionParams = (T, lo, hi, ids) =>
    ids ? [T, lo, hi, ids, T, lo, hi, ids] : [T, lo, hi, T, lo, hi];

// The money sums of a group of lines, cents-exact (every line is an integer quantity
// times a 2-decimal amount)
const SUMS = `SUM(x.qs) AS qty_sold, SUM(x.qr) AS qty_returned,
       ROUND(SUM(x.rs),2) AS sales, ROUND(SUM(x.rr),2) AS returns_value,
       ROUND(SUM(x.cs),2) AS cogs, ROUND(SUM(x.cr),2) AS returns_cost`;

// The lines summed per product first (`g`), then joined to the product: 2–3 times faster
// than grouping the joined rows by every product column (one narrow GROUP BY), with the
// same rows, since the filters only read the product's own attributes. Binds: union.
const BY_PRODUCT = `(SELECT x.product_id, ${SUMS}, SUM(x.fb) AS fallback_lines
      FROM (${LINES_UNION(false)}) x
      GROUP BY x.product_id) g
JOIN products p ON p.product_id = g.product_id`;

// The sums of several products (totals, rollups); still cents-exact
const GROUP_SUMS = `SUM(g.qty_sold) AS qty_sold, SUM(g.qty_returned) AS qty_returned,
       ROUND(SUM(g.sales),2) AS sales, ROUND(SUM(g.returns_value),2) AS returns_value,
       ROUND(SUM(g.cogs),2) AS cogs, ROUND(SUM(g.returns_cost),2) AS returns_cost`;

// Sort keys → fixed SQL. The money expressions equal the cents figures of the rows
// (net = sales − returns, gp = net − (cogs − returns cost)); margin is the exact ratio.
const NET = "(g.sales - g.returns_value)";
const GP = `(${NET} - (g.cogs - g.returns_cost))`;
const ORDER = {
    net_sales: NET,
    net_qty: "(g.qty_sold - g.qty_returned)",
    qty_sold: "g.qty_sold",
    qty_returned: "g.qty_returned",
    gross_profit: GP,
    margin_pct: `(${GP} / NULLIF(${NET}, 0))`,
    product_name: "p.product_name",
    on_hand: "COALESCE(st.on_hand, 0)",
};
const DIR = { asc: "ASC", desc: "DESC" };

// Only for sort = on_hand: Σ max(on_hand, 0) per live product over the shops of T with a
// live inventory row (the row figure of rk:products.stock, for every product). Binds [T, T].
const STOCK_JOIN = `
LEFT JOIN (SELECT i.product_id_fk AS product_id, SUM(GREATEST(COALESCE(oh.q, 0), 0)) AS on_hand
           FROM (SELECT MAX(record_id) AS rid FROM inventory
                 WHERE is_deleted = 0 AND database_id IN (?) GROUP BY product_id_fk, database_id) ix
           JOIN inventory i ON i.record_id = ix.rid
           JOIN products sp ON sp.product_id = i.product_id_fk AND sp.is_deleted = 0
           LEFT JOIN (SELECT database_id, product_id_fk, SUM(quantity) AS q FROM inventory_transactions
                      WHERE database_id IN (?) AND is_deleted = 0 GROUP BY database_id, product_id_fk) oh
                  ON oh.database_id = i.database_id AND oh.product_id_fk = i.product_id_fk
           GROUP BY i.product_id_fk) st ON st.product_id = g.product_id`;

// One page of products. `expr` is metrics.filterSql()'s (fixed fragments over `p`).
// Deleted products are kept (D10). Binds: union, [T, T] with the stock join, the filter,
// limit, offset.
const TABLE_SQL = (expr, sort, order) => `/* rk:products.table */
SELECT g.product_id, p.product_name, p.sku, p.is_deleted, c.category_name, b.brand_name,
       g.qty_sold, g.qty_returned, g.sales, g.returns_value, g.cogs, g.returns_cost
FROM ${BY_PRODUCT}
LEFT JOIN products_categories c ON c.category_id = p.category_id_fk
LEFT JOIN products_brands b ON b.brand_id = p.brand_id_fk${sort === "on_hand" ? STOCK_JOIN : ""}
WHERE ${expr}
ORDER BY ${ORDER[sort]} ${DIR[order]}, g.product_id
LIMIT ? OFFSET ?`;

// Every matching product, not only the page: the count (one g row per product) and the
// footer totals
const TOTALS_SQL = (expr) => `/* rk:products.totals */
SELECT COUNT(*) AS total_count, ${GROUP_SUMS}, SUM(g.fallback_lines) AS fallback_lines
FROM ${BY_PRODUCT}
WHERE ${expr}`;

// The page's products in each shop of T: signed on-hand (M16) and the M17 unit cost of
// the latest live inventory row. Deleted products have no stock (S7). Binds [T, ids, T, ids].
const STOCK_SQL = `/* rk:products.stock */
SELECT i.database_id, i.product_id_fk AS product_id, COALESCE(oh.q, 0) AS on_hand,
       COALESCE(NULLIF(i.avg_cost_usd,0), i.unit_cost_usd, 0) AS unit_cost
FROM (SELECT MAX(record_id) AS rid FROM inventory
      WHERE is_deleted = 0 AND database_id IN (?) AND product_id_fk IN (?)
      GROUP BY product_id_fk, database_id) ix
JOIN inventory i ON i.record_id = ix.rid
JOIN products p ON p.product_id = i.product_id_fk AND p.is_deleted = 0
LEFT JOIN (SELECT database_id, product_id_fk, SUM(quantity) AS q FROM inventory_transactions
           WHERE database_id IN (?) AND product_id_fk IN (?) AND is_deleted = 0
           GROUP BY database_id, product_id_fk) oh
       ON oh.database_id = i.database_id AND oh.product_id_fk = i.product_id_fk`;

// Combined: the page's products per shop
const BY_SHOP_SQL = `/* rk:products.by_shop */
SELECT x.product_id, x.database_id, ${SUMS}
FROM (${LINES_UNION(true)}) x
GROUP BY x.product_id, x.database_id`;

// Rollups over every product sold or returned in the range (no table filter). LEFT JOIN:
// a product without a category (or with a dangling one) is "Uncategorised", not dropped
// as by the legacy category report.
const ROLLUP_SQL = {
    category: `/* rk:products.rollup_category */
SELECT c.category_id AS id, c.category_name AS name, ${GROUP_SUMS}
FROM ${BY_PRODUCT}
LEFT JOIN products_categories c ON c.category_id = p.category_id_fk
GROUP BY c.category_id, c.category_name`,
    brand: `/* rk:products.rollup_brand */
SELECT b.brand_id AS id, b.brand_name AS name, ${GROUP_SUMS}
FROM ${BY_PRODUCT}
LEFT JOIN products_brands b ON b.brand_id = p.brand_id_fk
GROUP BY b.brand_id, b.brand_name`,
};

// ---------------------------------------------------------------- figures

// TINYINT(1) arrives as a boolean, comparisons as 0/1
const flag = (v) => Boolean(Number(v));

/** A grouped row's parts in cents and units. */
const partsOf = (r) => ({
    qty_sold: Number(r.qty_sold ?? 0),
    qty_returned: Number(r.qty_returned ?? 0),
    sales_c: toCents(r.sales),
    returns_c: toCents(r.returns_value),
    cogs_c: toCents(r.cogs),
    rcost_c: toCents(r.returns_cost),
});

/** Net sales in cents (M5), the ranking of the per-shop and rollup rows. */
const netCents = (p) => p.sales_c - p.returns_c;

/** The sales figures of a set of lines (M1–M7). */
function figures(p) {
    const net = netCents(p);
    const cogsNet = p.cogs_c - p.rcost_c;
    const gp = net - cogsNet;
    return {
        qty_sold: p.qty_sold,
        qty_returned: p.qty_returned,
        net_qty: p.qty_sold - p.qty_returned,
        sales: toMoney(p.sales_c),
        returns: toMoney(p.returns_c),
        net_sales: toMoney(net),
        cogs_net: toMoney(cogsNet),
        gross_profit: toMoney(gp),
        margin_pct: pct(gp, net),
    };
}

/** Inactive tenants of a Combined scope (INACTIVE_INCLUDED). */
function inactiveCount(T, directory) {
    const dirById = new Map(directory.map((d) => [d.database_id, d]));
    return T.filter((t) => {
        const d = dirById.get(t);
        return d && !(d.has_admin || d.has_live_user);
    }).length;
}

/**
 * One page of the Products table, with the totals of every matching product.
 *
 * @param {object} args
 * @param {{ key: string, mode: 'combined'|'single', database_ids: number[] }} args.scope
 * @param {ReturnType<typeof parseProductsTableBody>} args.params
 * @param {Array} args.directory  scope.loadDirectory() rows
 * @param {boolean} args.restricted  view_cost off and not the admin
 * @returns {Promise<{ payload: object, notes: Array<{code: string, count: number}> }>}
 */
async function getProductsTable({ scope, params, directory, restricted }) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";
    const { lo, hi } = params.range;
    // No cost-based ranking for a viewer who may not see cost (§3.5 sort leak guard)
    const sort = restricted && COST_SORTS.has(params.sort) ? "net_sales" : params.sort;
    const filter = M.filterSql(params);
    const union = unionParams(T, lo, hi);

    const [pageRows, [totalRow]] = await M.runLimited([
        async () =>
            (
                await pool.query(TABLE_SQL(filter.expr, sort, params.order), [
                    ...union,
                    ...(sort === "on_hand" ? [T, T] : []),
                    ...filter.params,
                    params.limit,
                    params.offset,
                ])
            )[0],
        async () => (await pool.query(TOTALS_SQL(filter.expr), [...union, ...filter.params]))[0],
    ]);

    const ids = pageRows.map((r) => Number(r.product_id));
    const [stockRows, shopRows] = await M.runLimited([
        ids.length ? async () => (await pool.query(STOCK_SQL, [T, ids, T, ids]))[0] : () => [],
        combined && ids.length
            ? async () => (await pool.query(BY_SHOP_SQL, unionParams(T, lo, hi, ids)))[0]
            : () => [],
    ]);

    // ---- current stock per (shop, product): signed on-hand, M17 cost in cents
    const stock = new Map();
    for (const r of stockRows) {
        stock.set(M.key(Number(r.database_id), Number(r.product_id)), {
            on_hand: Number(r.on_hand),
            unit_cost_c: toCents(r.unit_cost),
        });
    }
    const stockCostC = (s) => Math.max(s.on_hand, 0) * s.unit_cost_c;

    // ---- per shop (Combined): shops with lines in the range or a non-zero on-hand
    const shopLines = new Map();
    for (const r of shopRows) {
        shopLines.set(M.key(Number(r.database_id), Number(r.product_id)), partsOf(r));
    }
    const zero = { qty_sold: 0, qty_returned: 0, sales_c: 0, returns_c: 0, cogs_c: 0, rcost_c: 0 };
    const byShopOf = (productId) =>
        T.map((t) => {
            const k = M.key(t, productId);
            const lines = shopLines.get(k);
            const s = stock.get(k);
            if (!lines && !(s && s.on_hand !== 0)) return null;
            const f = figures(lines || zero);
            return {
                net_c: netCents(lines || zero),
                row: {
                    database_id: t,
                    qty_sold: f.qty_sold,
                    qty_returned: f.qty_returned,
                    net_qty: f.net_qty,
                    net_sales: f.net_sales,
                    gross_profit: f.gross_profit,
                    margin_pct: f.margin_pct,
                    on_hand: s ? s.on_hand : null,
                    stock_cost: s ? toMoney(stockCostC(s)) : null,
                },
            };
        })
            .filter(Boolean)
            .sort((a, b) => b.net_c - a.net_c || a.row.database_id - b.row.database_id)
            .map((x) => x.row);

    // ---- rows
    const rows = pageRows.map((r) => {
        const productId = Number(r.product_id);
        const isDeleted = flag(r.is_deleted);
        const f = figures(partsOf(r));
        let onHand = null;
        let stockC = null;
        if (!isDeleted) {
            onHand = 0;
            stockC = 0;
            for (const t of T) {
                const s = stock.get(M.key(t, productId));
                if (!s) continue;
                onHand += Math.max(s.on_hand, 0);
                stockC += stockCostC(s);
            }
        }
        const row = {
            product_id: productId,
            product_name: String(r.product_name ?? ""),
            sku: r.sku ?? null,
            category_name: r.category_name ?? null,
            brand_name: r.brand_name ?? null,
            is_deleted: isDeleted,
            ...f,
            on_hand: onHand,
            stock_cost: stockC === null ? null : toMoney(stockC),
        };
        if (combined) row.by_shop = byShopOf(productId);
        return row;
    });

    const totals = figures(partsOf(totalRow || {}));

    // ---- notes (plan §9): INACTIVE_INCLUDED first, then the cost-only ones
    const notes = [];
    const note = (code, count) => {
        if (count > 0) notes.push({ code, count });
    };
    if (combined) note("INACTIVE_INCLUDED", inactiveCount(T, directory));
    if (!restricted) {
        note("COST_FALLBACK_LINES", Number(totalRow?.fallback_lines ?? 0));
        // explains cogs_net when returns are in it (D-P5-S1)
        note("RETURN_COST_CURRENT_AVG", totals.qty_returned > 0 ? 1 : 0);
    }

    return {
        payload: {
            params: {
                sort,
                order: params.order,
                offset: params.offset,
                limit: params.limit,
                search: params.search,
                category_id: params.categoryId,
                brand_id: params.brandId,
                filtered:
                    params.categoryId !== null ||
                    params.brandId !== null ||
                    params.pattern !== null,
            },
            total_count: Number(totalRow?.total_count ?? 0),
            totals,
            rows,
        },
        notes,
    };
}

const nameOf = (r) => String(r.name ?? "");

// Ties of the rollups: name (case- and accent-insensitive), then id (null last)
const byNameThenId = (a, b) =>
    nameOf(a).localeCompare(nameOf(b), "en", { sensitivity: "base" }) ||
    (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER);

/** RollupRows of one grouping, by net sales, then name, then id. */
function rollupRows(rows, missingName) {
    return rows
        .map((r) => {
            const id = r.id === null || r.id === undefined ? null : Number(r.id);
            const parts = partsOf(r);
            const f = figures(parts);
            return {
                net_c: netCents(parts),
                row: {
                    id,
                    name: id === null ? missingName : String(r.name ?? ""),
                    qty_sold: f.qty_sold,
                    qty_returned: f.qty_returned,
                    net_qty: f.net_qty,
                    net_sales: f.net_sales,
                    gross_profit: f.gross_profit,
                    margin_pct: f.margin_pct,
                },
            };
        })
        .sort((a, b) => b.net_c - a.net_c || byNameThenId(a.row, b.row))
        .map((x) => x.row);
}

/**
 * Net sales and gross profit by category and by brand over the range, for every product
 * sold or returned in it (the table's filters do not apply). Ranked by net sales, never
 * by cost.
 *
 * @returns {Promise<{ payload: { by_category: Array, by_brand: Array }, notes: [] }>}
 */
async function getProductsRollup({ scope, params }) {
    const T = scope.database_ids;
    const { lo, hi } = params.range;
    const union = unionParams(T, lo, hi);
    const [cats, brands] = await M.runLimited([
        async () => (await pool.query(ROLLUP_SQL.category, union))[0],
        async () => (await pool.query(ROLLUP_SQL.brand, union))[0],
    ]);
    return {
        payload: {
            by_category: rollupRows(cats, "Uncategorised"),
            by_brand: rollupRows(brands, "No brand"),
        },
        notes: [],
    };
}

module.exports = {
    SORTS,
    LINES_UNION,
    unionParams,
    parseProductsTableBody,
    parseProductsRollupBody,
    getProductsTable,
    getProductsRollup,
};
