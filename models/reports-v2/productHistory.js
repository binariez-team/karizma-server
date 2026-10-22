const pool = require("../../config/database");
const validate = require("./validate");
const { badRequest } = require("./errors");
const { toCents, toMoney, asMoney, roundHalfAway } = require("./money");
const { parseRange } = require("./dates");
const { buildTenants } = require("./scope");
const M = require("./metrics");
const { LINES_UNION, unionParams } = require("./products");

// Product history: POST /reports/v2/product-history/{lines,product,ledger} (plan §6.4,
// §6.8, Phase 5).
//
// - lines: every sale and return line over a range (Mode A, and the "Sales & returns"
//   tab of Mode B with product_id set), returns negative, server-paged.
// - product: one product's header, a card per shop (stock, cost, prices, sales in the
//   range, last sale, receipts) and the cost trail (purchases, delivery snapshots, cost
//   revaluations, the monthly sale cost per shop; D5).
// - ledger: the product's stock movements with a running balance per shop.
//
// Money is put together here in integer cents; the client never adds money up.
// Deleted products keep their history (D10), but every stock figure of theirs is null
// (S7): on_hand, balance_after, opening, closing.
//
// Restricted viewers (view_cost off, D8): the controller strips unit_cost, profit,
// avg_cost, last_cost and cost_trail. Here the cost-trail statements are not run at all,
// the cost-only notes are left out, and the notes of the ledger's REVALUE rows are
// withheld: they read "avg_cost X -> Y by <user>" (AdminStockModel), a cost in plain text
// that no key strip would catch (D-P5-S3).
//
// Purchases and suppliers belong to the admin tenant: only the admin viewer gets the
// purchases list, and only the admin's ledger statement joins the supplier. No statement
// selects a supplier name for anyone else: the admin's staff read "Purchase", or
// "deleted purchase" once the purchase is gone (their statement joins the purchase for its
// id only).
//
// The shop cards' prices follow S5 (as Inventory, metrics.liveBase): a user shop's 0 / NULL
// price takes the admin tenant's current price for the product, per basis, and the card
// says which (`admin_prices`, D-P5-S15).
//
// Text columns of different tables have different collations (inventory_transactions
// notes, deliver_orders and dispose_products numbers), so they are never compared or
// merged in SQL: doc_no, counterparty and notes are worked out here.

const TRAIL_ROWS = 200; // purchases, deliveries, revaluations

// TINYINT(1) arrives as a boolean, comparisons as 0/1
const flag = (v) => Boolean(Number(v));
const idOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const nameOf = (v) => String(v ?? "").trim();
// a shop with no user_database row (old data, e.g. a delivery to shop 2) or no name:
// "Shop <id>", as the client names a shop outside its directory
const shopNameOf = (name, id) => nameOf(name) || `Shop ${Number(id)}`;

// "" counts as absent (validate.bool takes only undefined / null as absent)
const optBool = (v, field, def) => validate.bool(v === "" ? undefined : v, field, { def });

/**
 * Read the lines request (contract §3.5). Checked before the scope is resolved, so a bad
 * body issues no SQL. Unknown keys are ignored; "" counts as absent.
 */
function parseLinesBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const range = parseRange(b);
    const productId = validate.int(b.product_id, "product_id", { min: 1, def: null });
    const categoryId = validate.int(b.category_id, "category_id", { min: 1, def: null });
    const customerId = validate.int(b.customer_id, "customer_id", { min: 1, def: null });
    const pattern = validate.search(b.search);
    return {
        range,
        productId,
        categoryId,
        customerId,
        search: pattern === null ? null : b.search.trim(),
        pattern,
        includeReturns: optBool(b.include_returns, "include_returns", true),
        offset: validate.offset(b.offset),
        limit: validate.limit(b.limit, { max: 200, def: 25 }),
    };
}

/** Read the product request (contract §3.6): product_id and the range, both required. */
function parseProductBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const productId = validate.int(b.product_id, "product_id", { min: 1 });
    return { productId, range: parseRange(b) };
}

const absent = (v) => v === undefined || v === null || v === "";

/**
 * Read the ledger request (contract §3.7): product_id required; from and to both or
 * neither (one alone is 400 BAD_RANGE naming the missing one); limit 1..500.
 */
function parseLedgerBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const productId = validate.int(b.product_id, "product_id", { min: 1 });
    const range = absent(b.from) && absent(b.to) ? null : parseRange(b);
    return {
        productId,
        range,
        offset: validate.offset(b.offset),
        limit: validate.limit(b.limit, { max: 500, def: 50 }),
    };
}

// ---------------------------------------------------------------- shared

const query = async (sql, params) => (await pool.query(sql, params))[0];

// The product itself: global (products are shared by every shop), no T bind
const PRODUCT_SQL = `/* rk:history.product */
SELECT p.product_id, p.product_name, p.sku, p.is_deleted, c.category_name, b.brand_name
FROM products p
LEFT JOIN products_categories c ON c.category_id = p.category_id_fk
LEFT JOIN products_brands b ON b.brand_id = p.brand_id_fk
WHERE p.product_id = ?`;

/** The product header, or 400 BAD_REQUEST product_id before any other statement. */
async function productOf(productId) {
    const [r] = await query(PRODUCT_SQL, [productId]);
    if (!r) throw badRequest("product_id", "Unknown product.");
    return {
        product_id: Number(r.product_id),
        product_name: String(r.product_name ?? ""),
        sku: r.sku ?? null,
        category_name: r.category_name ?? null,
        brand_name: r.brand_name ?? null,
        is_deleted: flag(r.is_deleted),
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

/** Shop ids in chip order (colour index: the admin's shop first), unknown ones last. */
function chipOrder(directory, reports) {
    const idx = new Map(
        buildTenants(directory, { reports }).map((t) => [t.database_id, t.color_index]),
    );
    const at = (t) => (idx.has(t) ? idx.get(t) : Number.MAX_SAFE_INTEGER);
    return (a, b) => at(a) - at(b) || a - b;
}

// ---------------------------------------------------------------- lines (Mode A)

// A customer filter must name a customer of the scope's shops; checked before the lines
const CUSTOMER_CHECK_SQL = `/* rk:history.customer_check */
SELECT account_id FROM accounts WHERE account_id = ? AND is_customer = 1 AND database_id IN (?)`;

// The two arms of the lines set, each from fixed fragments. `rows` and `totals` are the
// select lists of the page and of the totals; returns are negative (qty and money). The
// product is joined in the arms only for the category and the Mode A search; the page's
// names are joined after its LIMIT (a narrow sort: about 40% faster on a year). With a
// product picked (Mode B) the search reads the document number only (`invoice`,
// D-P5-S14): the box says "Invoice number" there, and the product's own name or SKU
// would match every line.
const ARMS = {
    sale: {
        rows: `SELECT 'sale' AS kind, so.order_id AS doc_id, soi.order_item_id AS line_id, so.invoice_number AS doc_no,
         so.database_id, so.order_datetime AS datetime, so.customer_id, soi.product_id,
         soi.quantity AS qty, COALESCE(soi.unit_price,0) AS unit_price,
         soi.quantity * COALESCE(soi.unit_price,0) AS line_total,
         COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0) AS unit_cost`,
        totals: `SELECT soi.quantity AS qty, soi.quantity * COALESCE(soi.unit_price,0) AS line_total,
         soi.quantity * COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0) AS line_cost,
         (COALESCE(soi.avg_cost,0) = 0) AS fb, 0 AS rl`,
        from: `
  FROM sales_orders so
  JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0`,
        products: `
  LEFT JOIN products p ON p.product_id = soi.product_id`,
        where: `
  WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?`,
        product: " AND soi.product_id = ?",
        category: " AND p.category_id_fk = ?",
        customer: " AND so.customer_id = ?",
        search: " AND (p.product_name LIKE ? OR p.sku LIKE ? OR so.invoice_number LIKE ?)",
        invoice: " AND so.invoice_number LIKE ?",
    },
    return: {
        rows: `SELECT 'return', ro.order_id, roi.order_item_id, ro.invoice_number,
         ro.database_id, ro.order_datetime, ro.customer_id, roi.product_id,
         -roi.quantity, COALESCE(roi.unit_price,0),
         -(roi.quantity * COALESCE(roi.unit_price,0)),
         COALESCE(NULLIF(roi.avg_cost,0), roi.unit_cost, 0)`,
        totals: `SELECT -roi.quantity, -(roi.quantity * COALESCE(roi.unit_price,0)),
         -(roi.quantity * COALESCE(NULLIF(roi.avg_cost,0), roi.unit_cost, 0)),
         0, 1`,
        from: `
  FROM return_orders ro
  JOIN return_order_items roi ON roi.order_id = ro.order_id AND roi.is_deleted = 0`,
        products: `
  LEFT JOIN products p ON p.product_id = roi.product_id`,
        where: `
  WHERE ro.database_id IN (?) AND ro.is_deleted = 0 AND ro.order_datetime >= ? AND ro.order_datetime < ?`,
        product: " AND roi.product_id = ?",
        category: " AND p.category_id_fk = ?",
        customer: " AND ro.customer_id = ?",
        search: " AND (p.product_name LIKE ? OR p.sku LIKE ? OR ro.invoice_number LIKE ?)",
        invoice: " AND ro.invoice_number LIKE ?",
    },
};

/** The UNION ALL of the arms with the request's filters, and its binds in order. */
function linesSet(params, T, list) {
    const kinds = params.includeReturns ? ["sale", "return"] : ["sale"];
    const { lo, hi } = params.range;
    const byDoc = params.productId !== null; // Mode B: the document number only
    const needsProduct = params.categoryId !== null || (params.pattern !== null && !byDoc);
    const binds = [];
    const parts = kinds.map((kind) => {
        const a = ARMS[kind];
        let sql = a[list] + a.from + (needsProduct ? a.products : "") + a.where;
        binds.push(T, lo, hi);
        if (params.productId !== null) {
            sql += a.product;
            binds.push(params.productId);
        }
        if (params.categoryId !== null) {
            sql += a.category;
            binds.push(params.categoryId);
        }
        if (params.customerId !== null) {
            sql += a.customer;
            binds.push(params.customerId);
        }
        if (params.pattern !== null && byDoc) {
            sql += a.invoice;
            binds.push(params.pattern);
        } else if (params.pattern !== null) {
            sql += a.search;
            binds.push(params.pattern, params.pattern, params.pattern);
        }
        return `  ${sql}`;
    });
    return { sql: parts.join("\n  UNION ALL\n"), binds };
}

// The page, newest first. Document ids of sales and returns overlap, so `kind` and the
// line id keep the order total and paging stable. Names are joined to the page only.
const LINES_SQL = (set) => `/* rk:history.lines */
SELECT l.*, p.product_name, p.sku, p.is_deleted AS product_deleted, a.name AS customer_name
FROM (SELECT * FROM (
${set}
      ) u
      ORDER BY u.datetime DESC, u.kind, u.doc_id DESC, u.line_id DESC
      LIMIT ? OFFSET ?) l
LEFT JOIN products p ON p.product_id = l.product_id
LEFT JOIN accounts a ON a.account_id = l.customer_id
ORDER BY l.datetime DESC, l.kind, l.doc_id DESC, l.line_id DESC`;

// Count and totals of every matching line (not only the page); return_lines feeds
// RETURN_COST_CURRENT_AVG (D-P5-S18)
const LINES_TOTALS_SQL = (set) => `/* rk:history.lines_totals */
SELECT COUNT(*) AS total_count, SUM(l.qty) AS qty, ROUND(SUM(l.line_total),2) AS net_sales,
       ROUND(SUM(l.line_cost),2) AS line_cost, SUM(l.fb) AS fallback_lines, SUM(l.rl) AS return_lines
FROM (
${set}
) l`;

/**
 * One page of sale and return lines, with the totals of every matching line.
 *
 * @returns {Promise<{ payload: object, notes: Array<{code: string, count: number}> }>}
 */
async function getLines({ scope, params, directory, restricted }) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";

    if (params.customerId !== null) {
        const found = await query(CUSTOMER_CHECK_SQL, [params.customerId, T]);
        if (!found.length) throw badRequest("customer_id", "Unknown customer.");
    }

    const page = linesSet(params, T, "rows");
    const all = linesSet(params, T, "totals");
    const [lineRows, [t]] = await M.runLimited([
        () => query(LINES_SQL(page.sql), [...page.binds, params.limit, params.offset]),
        () => query(LINES_TOTALS_SQL(all.sql), all.binds),
    ]);

    const rows = lineRows.map((r) => {
        const qty = Number(r.qty);
        const lineTotalC = toCents(r.line_total);
        const unitCostC = toCents(r.unit_cost);
        return {
            kind: r.kind === "return" ? "return" : "sale",
            doc_id: Number(r.doc_id),
            line_id: Number(r.line_id),
            doc_no: r.doc_no ?? null,
            database_id: Number(r.database_id),
            datetime: r.datetime,
            customer_id: idOrNull(r.customer_id),
            customer_name:
                r.customer_id === null || r.customer_id === undefined
                    ? null
                    : (r.customer_name ?? null),
            product_id: idOrNull(r.product_id),
            product_name: String(r.product_name ?? ""),
            sku: r.sku ?? null,
            product_deleted: flag(r.product_deleted),
            qty,
            unit_price: toMoney(toCents(r.unit_price)),
            line_total: toMoney(lineTotalC),
            unit_cost: toMoney(unitCostC),
            profit: toMoney(lineTotalC - qty * unitCostC),
        };
    });

    const netC = toCents(t?.net_sales);
    const totals = {
        qty: Number(t?.qty ?? 0),
        net_sales: toMoney(netC),
        profit: toMoney(netC - toCents(t?.line_cost)),
    };

    const notes = [];
    const note = (code, count) => {
        if (count > 0) notes.push({ code, count });
    };
    if (combined) note("INACTIVE_INCLUDED", inactiveCount(T, directory));
    if (!restricted) {
        note("COST_FALLBACK_LINES", Number(t?.fallback_lines ?? 0));
        // explains the profit when return lines are in it (D-P5-S18, as D-P5-S1)
        note("RETURN_COST_CURRENT_AVG", Number(t?.return_lines ?? 0) > 0 ? 1 : 0);
    }

    return {
        payload: {
            params: {
                product_id: params.productId,
                category_id: params.categoryId,
                customer_id: params.customerId,
                search: params.search,
                include_returns: params.includeReturns,
                offset: params.offset,
                limit: params.limit,
                // the product is the page's subject (Mode B), not a filter
                filtered:
                    params.categoryId !== null ||
                    params.customerId !== null ||
                    params.pattern !== null ||
                    !params.includeReturns,
            },
            total_count: Number(t?.total_count ?? 0),
            totals,
            rows,
        },
        notes,
    };
}

// ---------------------------------------------------------------- product (Mode B summary)

// The product's latest live inventory row per shop of T (LIVE_INV): cost (M17), last
// cost, the shop's own prices and threshold. The admin tenant's latest live row of the
// product (ax / ai, the same MAX(record_id) rule as metrics.liveBase) carries his prices
// for the S5 fallback (D-P5-S15); its bind is the admin tenant, not T.
const SHOP_STOCK_SQL = `/* rk:history.shop_stock */
SELECT i.database_id, COALESCE(NULLIF(i.avg_cost_usd,0), i.unit_cost_usd, 0) AS unit_cost,
       i.unit_cost_usd, i.unit_price_usd, i.whole_price_usd, i.grandwhole_price_usd, i.low_stock_threshold,
       ai.unit_price_usd AS admin_unit_price_usd, ai.whole_price_usd AS admin_whole_price_usd,
       ai.grandwhole_price_usd AS admin_grandwhole_price_usd
FROM (SELECT MAX(record_id) AS rid FROM inventory
      WHERE is_deleted = 0 AND database_id IN (?) AND product_id_fk = ? GROUP BY database_id) ix
JOIN inventory i ON i.record_id = ix.rid
LEFT JOIN (SELECT MAX(record_id) AS rid, product_id_fk FROM inventory
           WHERE is_deleted = 0 AND database_id IN (?) AND product_id_fk = ? GROUP BY product_id_fk) ax
       ON ax.product_id_fk = i.product_id_fk
LEFT JOIN inventory ai ON ai.record_id = ax.rid`;

// M16 per shop
const SHOP_ON_HAND_SQL = `/* rk:history.shop_on_hand */
SELECT database_id, SUM(quantity) AS on_hand FROM inventory_transactions
WHERE database_id IN (?) AND product_id_fk = ? AND is_deleted = 0 GROUP BY database_id`;

// Sales and returns of the product in the range, per shop (the Products figures)
const SHOP_SALES_SQL = `/* rk:history.shop_sales */
SELECT x.database_id, SUM(x.qs) AS qty_sold, SUM(x.qr) AS qty_returned,
       ROUND(SUM(x.rs),2) AS sales, ROUND(SUM(x.rr),2) AS returns_value,
       ROUND(SUM(x.cs),2) AS cogs, ROUND(SUM(x.cr),2) AS returns_cost
FROM (${LINES_UNION(true)}) x
GROUP BY x.database_id`;

// M26 for the product: from the sales documents (a deleted sale keeps its ledger rows)
const LAST_SALE_SQL = `/* rk:history.last_sale */
SELECT so.database_id, MAX(so.order_datetime) AS last_sale
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
WHERE so.database_id IN (?) AND so.is_deleted = 0 AND soi.product_id = ?
GROUP BY so.database_id`;

// M27 for the product (ledger stamps; a delivery's receipt is its approval)
const RECEIPTS_SQL = `/* rk:history.receipts */
SELECT database_id, MIN(transaction_datetime) AS first_receipt, MAX(transaction_datetime) AS last_receipt
FROM inventory_transactions
WHERE database_id IN (?) AND product_id_fk = ? AND is_deleted = 0 AND quantity > 0
  AND transaction_type IN ('SUPPLY','DELIVER','ADD')
GROUP BY database_id`;

// Cost trail (unrestricted viewers only). Deliveries into or out of the scope's shops,
// dispatched in the range or still pending, newest first: units and the dispatch
// snapshot of the product's lines, both shops' names.
const DELIVERIES_SQL = `/* rk:history.deliveries */
SELECT d.order_id, d.invoice_number, d.order_datetime AS dispatched_at, d.approved_at, d.is_approved,
       d.admin_id_fk AS sender_id, d.database_id AS receiver_id,
       us.database_name AS sender_name, ur.database_name AS receiver_name,
       SUM(di.quantity) AS quantity, SUM(di.avg_cost_usd IS NULL) AS legacy_lines,
       MIN(di.avg_cost_usd) AS snap_min, MAX(di.avg_cost_usd) AS snap_max,
       ROUND(SUM(di.quantity * di.avg_cost_usd),2) AS snap_value
FROM deliver_orders d
JOIN deliver_order_items di ON di.order_id_fk = d.order_id AND di.is_deleted = 0 AND di.product_id = ?
LEFT JOIN user_database us ON us.database_id = d.admin_id_fk
LEFT JOIN user_database ur ON ur.database_id = d.database_id
WHERE d.is_deleted = 0 AND (d.database_id IN (?) OR d.admin_id_fk IN (?))
  AND ((d.order_datetime >= ? AND d.order_datetime < ?) OR d.is_approved = 0)
GROUP BY d.order_id, d.invoice_number, d.order_datetime, d.approved_at, d.is_approved,
         d.admin_id_fk, d.database_id, us.database_name, ur.database_name
ORDER BY d.order_datetime DESC, d.order_id DESC
LIMIT ?`;

// Cost revaluations of the product in the scope's shops (admin-only writes; notes read
// "avg_cost X -> Y by <user>")
const REVALUES_SQL = `/* rk:history.revalues */
SELECT transaction_id, database_id, transaction_datetime, transaction_notes
FROM inventory_transactions
WHERE database_id IN (?) AND product_id_fk = ? AND is_deleted = 0 AND transaction_type = 'REVALUE'
  AND transaction_datetime >= ? AND transaction_datetime < ?
ORDER BY transaction_datetime DESC, transaction_id DESC
LIMIT ?`;

// The cost of the units sold per month and shop (F_S, LINE_COST)
const MONTHLY_SALE_COST_SQL = `/* rk:history.monthly_sale_cost */
SELECT DATE_FORMAT(so.order_datetime, '%Y-%m') AS ym, so.database_id, SUM(soi.quantity) AS units,
       ROUND(SUM(soi.quantity * COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0)),2) AS line_cost
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?
  AND soi.product_id = ?
GROUP BY ym, so.database_id
ORDER BY ym, so.database_id`;

// Purchases of the product (admin viewer only), one row per purchase line. Bound to the
// admin tenant, not T: purchase_orders.database_id is NULL on every row (D-P3-S2). No
// is_supplier filter: a purchase may have no supplier (partner_id_fk NULL).
const PURCHASES_SQL = `/* rk:history.purchases */
SELECT po.order_id, poi.order_item_id AS line_id, po.invoice_number, po.order_datetime,
       a.name AS supplier_name, poi.quantity, poi.unit_cost_usd
FROM purchase_orders po
JOIN purchase_order_items poi ON poi.order_id_fk = po.order_id AND poi.is_deleted = 0
LEFT JOIN accounts a ON a.account_id = po.partner_id_fk
WHERE po.is_deleted = 0 AND (po.database_id IS NULL OR po.database_id IN (?))
  AND poi.product_id_fk = ? AND po.order_datetime >= ? AND po.order_datetime < ?
ORDER BY po.order_datetime DESC, po.order_id DESC, poi.order_item_id DESC
LIMIT ?`;

/** A delivery's snapshot per unit: null if any line has none, else the lines' one value. */
function snapshotOf(r, units) {
    if (Number(r.legacy_lines ?? 0) > 0 || r.snap_min === null || r.snap_min === undefined) {
        return null;
    }
    const min = toCents(r.snap_min);
    if (min === toCents(r.snap_max) || units <= 0) return toMoney(min);
    // lines of one order at different snapshots (not seen in the data): their average
    return toMoney(roundHalfAway(toCents(r.snap_value) / units));
}

// A card's price keys and their inventory columns
const PRICES = [
    ["unit_price", "unit_price_usd"],
    ["whole_price", "whole_price_usd"],
    ["grand_price", "grandwhole_price_usd"],
];

/**
 * A shop card's three prices (S5, as metrics.liveBase; D-P5-S15): on a user shop's row, a
 * price of 0 or NULL for a basis takes the admin tenant's current price for it, each basis
 * on its own; the admin's own shop never falls back, and an admin price of 0 / NULL leaves
 * the shop's as stored. `admin_prices` names the prices that are the admin's. No live row:
 * every price null (D-P5-S8).
 */
function cardPrices(s, mayFallBack) {
    const out = { admin_prices: [] };
    for (const [key, col] of PRICES) {
        if (s && mayFallBack && toCents(s[col]) === 0 && toCents(s[`admin_${col}`]) !== 0) {
            out[key] = asMoney(s[`admin_${col}`]);
            out.admin_prices.push(key);
        } else {
            out[key] = s ? asMoney(s[col]) : null;
        }
    }
    return out;
}

/**
 * The Mode B summary: the product, a card per shop and (unrestricted) the cost trail.
 *
 * @returns {Promise<{ payload: object, notes: Array<{code: string, count: number}> }>}
 */
async function getProduct({ scope, params, reports, directory, restricted }) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";
    const { lo, hi } = params.range;

    const product = await productOf(params.productId);
    const pid = product.product_id;
    const withTrail = !restricted;
    const withPurchases = withTrail && reports.isAdmin;
    const none = () => [];
    // Whose prices a user shop's unpriced row takes (S5, as Inventory): the admin tenant,
    // which is the admin caller's own (A11), else the tenant with an admin login
    const priceAdminDb = reports.isAdmin
        ? reports.databaseId
        : (directory.find((d) => d.has_admin)?.database_id ?? null);

    // Never more than 4 queries at a time; the cost trail only for a viewer who may see cost
    const [
        stockRows, onHandRows, salesRows, lastRows, receiptRows,
        deliveryRows, revalueRows, monthlyRows, purchaseRows,
    ] = await M.runLimited([
        // 0 matches no tenant: no admin tenant, no fallback
        () => query(SHOP_STOCK_SQL, [T, pid, [priceAdminDb ?? 0], pid]),
        () => query(SHOP_ON_HAND_SQL, [T, pid]),
        () => query(SHOP_SALES_SQL, unionParams(T, lo, hi, [pid])),
        () => query(LAST_SALE_SQL, [T, pid]),
        () => query(RECEIPTS_SQL, [T, pid]),
        withTrail ? () => query(DELIVERIES_SQL, [pid, T, T, lo, hi, TRAIL_ROWS]) : none,
        withTrail ? () => query(REVALUES_SQL, [T, pid, lo, hi, TRAIL_ROWS]) : none,
        withTrail ? () => query(MONTHLY_SALE_COST_SQL, [T, lo, hi, pid]) : none,
        withPurchases
            ? () => query(PURCHASES_SQL, [[reports.databaseId], pid, lo, hi, TRAIL_ROWS])
            : none,
    ]);

    const byDb = (rows) => new Map(rows.map((r) => [Number(r.database_id), r]));
    const stock = byDb(stockRows);
    const onHand = byDb(onHandRows);
    const sales = byDb(salesRows);
    const last = byDb(lastRows);
    const rec = byDb(receiptRows);

    // Single scope: always that shop. Combined: shops with a live row, ledger rows or
    // lines in the range.
    const shopIds = (
        combined ? T.filter((t) => stock.has(t) || onHand.has(t) || sales.has(t)) : [...T]
    ).sort(chipOrder(directory, reports));

    const shops = shopIds.map((t) => {
        const s = stock.get(t);
        const x = sales.get(t);
        const salesC = toCents(x?.sales);
        const returnsC = toCents(x?.returns_value);
        const netC = salesC - returnsC;
        const profitC = netC - (toCents(x?.cogs) - toCents(x?.returns_cost));
        const price = cardPrices(s, priceAdminDb !== null && t !== priceAdminDb);
        return {
            database_id: t,
            on_hand: product.is_deleted ? null : Number(onHand.get(t)?.on_hand ?? 0),
            avg_cost: s ? asMoney(s.unit_cost) : null,
            last_cost: s ? asMoney(s.unit_cost_usd) : null,
            unit_price: price.unit_price,
            whole_price: price.whole_price,
            grand_price: price.grand_price,
            admin_prices: price.admin_prices,
            low_stock_threshold: s ? idOrNull(s.low_stock_threshold) : null,
            qty_sold: Number(x?.qty_sold ?? 0),
            qty_returned: Number(x?.qty_returned ?? 0),
            net_sales: toMoney(netC),
            profit: toMoney(profitC),
            last_sale: last.get(t)?.last_sale ?? null,
            first_receipt: rec.get(t)?.first_receipt ?? null,
            last_receipt: rec.get(t)?.last_receipt ?? null,
        };
    });

    const payload = { product, shops };
    let legacyOrders = 0;
    if (withTrail) {
        const deliveries = deliveryRows.map((r) => {
            const quantity = Number(r.quantity ?? 0);
            const snapshot = snapshotOf(r, quantity);
            if (snapshot === null) legacyOrders += 1;
            return {
                order_id: Number(r.order_id),
                invoice_number: r.invoice_number ?? null,
                dispatched_at: r.dispatched_at,
                approved_at: r.approved_at ?? null,
                is_approved: flag(r.is_approved),
                sender_id: Number(r.sender_id),
                receiver_id: Number(r.receiver_id),
                sender_name: shopNameOf(r.sender_name, r.sender_id),
                receiver_name: shopNameOf(r.receiver_name, r.receiver_id),
                quantity,
                snapshot_cost: snapshot,
            };
        });
        payload.cost_trail = {
            purchases: purchaseRows.map((r) => ({
                order_id: Number(r.order_id),
                line_id: Number(r.line_id),
                invoice_number: r.invoice_number ?? null,
                order_datetime: r.order_datetime,
                supplier_name: r.supplier_name ?? null,
                quantity: asMoney(r.quantity), // DECIMAL(10,2), 2 decimals
                unit_cost_usd: asMoney(r.unit_cost_usd),
            })),
            deliveries,
            revalues: revalueRows.map((r) => ({
                transaction_id: Number(r.transaction_id),
                database_id: Number(r.database_id),
                transaction_datetime: r.transaction_datetime,
                notes: String(r.transaction_notes ?? ""),
            })),
            monthly_sale_cost: monthlyRows
                .filter((r) => Number(r.units ?? 0) > 0)
                .map((r) => {
                    const units = Number(r.units);
                    return {
                        month: String(r.ym),
                        database_id: Number(r.database_id),
                        units,
                        avg_unit_cost: toMoney(roundHalfAway(toCents(r.line_cost) / units)),
                    };
                }),
        };
    }

    const notes = [];
    const note = (code, count) => {
        if (count > 0) notes.push({ code, count });
    };
    if (combined) note("INACTIVE_INCLUDED", inactiveCount(T, directory));
    note("RECEIPT_IS_APPROVAL", 1);
    if (withTrail) {
        // the cards' profit includes returns costed at the shop's average (D-P5-S18)
        note("RETURN_COST_CURRENT_AVG", shops.some((s) => s.qty_returned > 0) ? 1 : 0);
        note("LEGACY_DELIVERY_SNAPSHOT", legacyOrders);
        note("HISTORIC_COST_DISTORTION", 1);
    }

    return { payload, notes };
}

// ---------------------------------------------------------------- ledger (Mode B stock movements)

// The running balance is computed over ALL the product's rows of each shop (inner
// derived table), and only then is the range applied (outer WHERE), so the balance is
// right on every page. Constant variants: both join the purchase of SUPPLY rows; the
// admin's also selects its number and joins its supplier; nobody else's selects more than
// the purchase id (whether it still exists, D-P5-S16) and no supplier at all.
const LEDGER_SQL = (admin, ranged) => `/* rk:history.ledger */
SELECT l.transaction_id, l.transaction_datetime, l.database_id, l.transaction_type, l.quantity,
       l.order_id_fk, l.transaction_notes, l.balance_after,
       so.order_id AS sale_id, so.invoice_number AS sale_no, so.is_deleted AS sale_deleted,
       so.customer_id, ca.name AS customer_name,
       d.order_id AS deliver_id, d.invoice_number AS deliver_no,
       d.admin_id_fk AS from_database_id, d.database_id AS to_database_id,
       uf.database_name AS from_name, ut.database_name AS to_name,
       dp.dispose_id, dp.invoice_number AS dispose_no,
       po.order_id AS purchase_id${admin ? `, po.invoice_number AS purchase_no, sa.name AS supplier_name` : ""}
FROM (SELECT it.transaction_id, it.transaction_datetime, it.database_id, it.transaction_type,
             it.quantity, it.order_id_fk, it.transaction_notes,
             SUM(it.quantity) OVER (PARTITION BY it.database_id
                                    ORDER BY it.transaction_datetime, it.transaction_id) AS balance_after
      FROM inventory_transactions it
      WHERE it.product_id_fk = ? AND it.database_id IN (?) AND it.is_deleted = 0) l
LEFT JOIN sales_orders so ON l.transaction_type = 'SALE' AND so.order_id = l.order_id_fk
LEFT JOIN accounts ca ON ca.account_id = so.customer_id
LEFT JOIN deliver_orders d ON l.transaction_type = 'DELIVER' AND d.order_id = l.order_id_fk
LEFT JOIN user_database uf ON uf.database_id = d.admin_id_fk
LEFT JOIN user_database ut ON ut.database_id = d.database_id
LEFT JOIN dispose_products dp ON l.transaction_type = 'DISPOSE' AND dp.dispose_id = l.order_id_fk
LEFT JOIN purchase_orders po ON l.transaction_type = 'SUPPLY' AND po.order_id = l.order_id_fk${admin ? `
LEFT JOIN accounts sa ON sa.account_id = po.partner_id_fk` : ""}${ranged ? `
WHERE l.transaction_datetime >= ? AND l.transaction_datetime < ?` : ""}
ORDER BY l.transaction_datetime DESC, l.transaction_id DESC
LIMIT ? OFFSET ?`;

// Per shop: the balance before the range (opening), at its end (closing) and the rows
// in it. Without a range: opening 0, closing = every row.
const LEDGER_SUMMARY_SQL = {
    ranged: `/* rk:history.ledger_summary */
SELECT database_id,
       SUM(CASE WHEN transaction_datetime < ? THEN quantity ELSE 0 END) AS opening,
       SUM(CASE WHEN transaction_datetime < ? THEN quantity ELSE 0 END) AS closing,
       SUM(CASE WHEN transaction_datetime >= ? AND transaction_datetime < ? THEN 1 ELSE 0 END) AS in_range
FROM inventory_transactions
WHERE product_id_fk = ? AND database_id IN (?) AND is_deleted = 0
GROUP BY database_id`,
    all: `/* rk:history.ledger_summary */
SELECT database_id, 0 AS opening, SUM(quantity) AS closing, COUNT(*) AS in_range
FROM inventory_transactions
WHERE product_id_fk = ? AND database_id IN (?) AND is_deleted = 0
GROUP BY database_id`,
};

/**
 * One ledger row (contract §3.7): the document number and counterparty by type, and the
 * notes unless they only repeat the number. `admin`: the admin viewer (supplier names);
 * `restricted`: cost revaluation notes withheld; `deleted`: no balance (S7).
 */
function ledgerRow(r, { admin, restricted, deleted }) {
    const type = String(r.transaction_type);
    const text = r.transaction_notes ?? null;
    let docNo = null;
    let counterparty = null;
    const extra = {};

    switch (type) {
        case "SALE":
            if (r.sale_id !== null && r.sale_id !== undefined) {
                docNo = r.sale_no ?? null;
                counterparty =
                    r.customer_id === null || r.customer_id === undefined
                        ? "Walk-in"
                        : (r.customer_name ?? null);
                extra.doc_deleted = flag(r.sale_deleted);
            } else {
                docNo = text;
            }
            break;
        case "SUPPLY": {
            // a deleted purchase is hard-deleted (PurchaseModel): nothing joins
            const found = r.purchase_id !== null && r.purchase_id !== undefined;
            if (admin) {
                docNo = (found ? r.purchase_no : null) ?? text;
                counterparty = found ? (r.supplier_name ?? "No supplier") : "deleted purchase";
            } else {
                docNo = text;
                counterparty = found ? "Purchase" : "deleted purchase";
            }
            break;
        }
        case "DELETE":
            // a deleted purchase keeps its order id (PurchaseModel), a deleted invoice not
            docNo = text;
            counterparty =
                r.order_id_fk === null || r.order_id_fk === undefined
                    ? "deleted invoice"
                    : "deleted purchase";
            break;
        case "DELIVER":
            if (r.deliver_id !== null && r.deliver_id !== undefined) {
                docNo = r.deliver_no ?? null;
                counterparty = `${shopNameOf(r.from_name, r.from_database_id)} → ${shopNameOf(r.to_name, r.to_database_id)}`;
                extra.from_database_id = Number(r.from_database_id);
                extra.to_database_id = Number(r.to_database_id);
            }
            break;
        case "DISPOSE":
            docNo = r.dispose_no ?? null;
            break;
        default:
            // RETURN, REVERSERETURN, REVERSEDISPOSE (REVERSEDELIVER: in the enum, no
            // writer today): no document, no notes (D3);
            // ADD, REMOVE: the user's text; REVALUE: the cost change as text
            break;
    }

    let notes = text === docNo ? null : text;
    if (type === "REVALUE" && restricted) notes = null;

    return {
        transaction_id: Number(r.transaction_id),
        datetime: r.transaction_datetime,
        database_id: Number(r.database_id),
        type,
        doc_no: docNo,
        counterparty,
        ...("from_database_id" in extra
            ? { from_database_id: extra.from_database_id, to_database_id: extra.to_database_id }
            : {}),
        ...("doc_deleted" in extra ? { doc_deleted: extra.doc_deleted } : {}),
        qty: Number(r.quantity),
        balance_after: deleted ? null : Number(r.balance_after),
        notes,
    };
}

/**
 * The product's stock movements, newest first, with the running balance per shop.
 *
 * @returns {Promise<{ payload: object, notes: Array<{code: string, count: number}> }>}
 */
async function getLedger({ scope, params, reports, directory, restricted }) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";
    const admin = reports.isAdmin;
    const ranged = params.range !== null;

    const header = await productOf(params.productId);
    const pid = header.product_id;
    const deleted = header.is_deleted;

    const [rows, summary] = await M.runLimited([
        () =>
            query(LEDGER_SQL(admin, ranged), [
                pid,
                T,
                ...(ranged ? [params.range.lo, params.range.hi] : []),
                params.limit,
                params.offset,
            ]),
        () =>
            ranged
                ? query(LEDGER_SUMMARY_SQL.ranged, [
                      params.range.lo,
                      params.range.hi,
                      params.range.lo,
                      params.range.hi,
                      pid,
                      T,
                  ])
                : query(LEDGER_SUMMARY_SQL.all, [pid, T]),
    ]);

    const sums = new Map(summary.map((r) => [Number(r.database_id), r]));
    // Single scope: always that shop; Combined: the shops with ledger rows
    const shopIds = (combined ? T.filter((t) => sums.has(t)) : [...T]).sort(
        chipOrder(directory, reports),
    );
    const opening_by_shop = shopIds.map((t) => {
        const s = sums.get(t);
        return {
            database_id: t,
            opening: deleted ? null : Number(s?.opening ?? 0),
            closing: deleted ? null : Number(s?.closing ?? 0),
        };
    });
    const total_count = summary.reduce((n, r) => n + Number(r.in_range ?? 0), 0);

    return {
        payload: {
            product: {
                product_id: header.product_id,
                product_name: header.product_name,
                is_deleted: deleted,
            },
            total_count,
            opening_by_shop,
            rows: rows.map((r) => ledgerRow(r, { admin, restricted, deleted })),
        },
        notes: [{ code: "LEDGER_CLOCK", count: 1 }],
    };
}

module.exports = {
    parseLinesBody,
    parseProductBody,
    parseLedgerBody,
    getLines,
    getProduct,
    getLedger,
};
