const pool = require("../../config/database");
const { badRequest } = require("./errors");
const validate = require("./validate");

// Pick lists of the report filters: POST /reports/v2/lookups (plan §6.8).
//
// - `categories` and `brands` (Phase 2): global, non-deleted rows, the same for every
//   shop. The limit goes up to 500 (default 500), because there are more than 50
//   categories (D-P2-2).
// - `customers` (Phase 5): the customer accounts of the scope's shops, T bound like every
//   report statement, so a user or staff viewer only ever lists his own shop's
//   customers. Deleted customers are listed after the live ones, with a flag (their past
//   sales stay in the history).
// - `products` (Phase 5): global by design (§6.8): the catalogue is shared, so the picker
//   finds any product by name or SKU, deleted ones last, with a flag (their sales history
//   stays visible, D10). No T bind.
// Both Phase 5 kinds take a limit of 1..50 (default 20). Any other kind is refused before
// any SQL. One extra row is read to tell the client the list was cut.

const SQL = {
    categories: {
        select: `/* rk:lookups.categories */ SELECT category_id AS id, category_name AS name FROM products_categories
WHERE is_deleted = 0`,
        search: ` AND category_name LIKE ?`,
        order: ` ORDER BY category_name, category_id LIMIT ?`,
    },
    brands: {
        select: `/* rk:lookups.brands */ SELECT brand_id AS id, brand_name AS name FROM products_brands
WHERE is_deleted = 0`,
        search: ` AND brand_name LIKE ?`,
        order: ` ORDER BY brand_name, brand_id LIMIT ?`,
    },
    customers: {
        select: `/* rk:lookups.customers */ SELECT account_id AS id, name, is_deleted, database_id FROM accounts
WHERE is_customer = 1 AND database_id IN (?)`,
        search: ` AND name LIKE ?`,
        order: ` ORDER BY is_deleted, name, account_id LIMIT ?`,
    },
    products: {
        select: `/* rk:lookups.products */ SELECT product_id AS id, product_name AS name, sku, is_deleted FROM products`,
        search: `
WHERE (product_name LIKE ? OR sku LIKE ?)`,
        order: ` ORDER BY is_deleted, product_name, product_id LIMIT ?`,
    },
};
const KINDS = new Set(Object.keys(SQL));

// Page size per kind: max and default
const LIMITS = {
    categories: { max: 500, def: 500 },
    brands: { max: 500, def: 500 },
    customers: { max: 50, def: 20 },
    products: { max: 50, def: 20 },
};

/**
 * Read the request body. Unknown keys are ignored.
 *
 * @returns {{ kind: 'categories'|'brands'|'customers'|'products', pattern: string|null,
 *   limit: number }}
 */
function parseLookupsBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    if (!KINDS.has(b.kind)) {
        throw badRequest("kind", "This list is not available yet.");
    }
    return {
        kind: b.kind,
        pattern: validate.search(b.search),
        limit: validate.limit(b.limit, LIMITS[b.kind]),
    };
}

// TINYINT(1) arrives as a boolean
const flag = (v) => Boolean(Number(v));

const ROW = {
    categories: (r) => ({ id: Number(r.id), name: String(r.name ?? "") }),
    brands: (r) => ({ id: Number(r.id), name: String(r.name ?? "") }),
    customers: (r) => ({
        id: Number(r.id),
        name: String(r.name ?? ""),
        is_deleted: flag(r.is_deleted),
        database_id: Number(r.database_id),
    }),
    products: (r) => ({
        id: Number(r.id),
        name: String(r.name ?? ""),
        sku: r.sku ?? null,
        is_deleted: flag(r.is_deleted),
    }),
};

/**
 * One pick list. `T` is the scope's tenant list (resolveScope); only `customers` binds it.
 *
 * @returns {Promise<{ kind: string, rows: Array<{id: number, name: string, sku?: string|null,
 *   is_deleted?: boolean, database_id?: number}>, truncated: boolean }>}
 */
async function getLookups({ kind, pattern, limit }, T) {
    const q = SQL[kind];
    const sql = q.select + (pattern === null ? "" : q.search) + q.order;
    const params = [];
    if (kind === "customers") params.push(T);
    if (pattern !== null) params.push(...(kind === "products" ? [pattern, pattern] : [pattern]));
    params.push(limit + 1);

    const [rows] = await pool.query(sql, params);
    return {
        kind,
        rows: rows.slice(0, limit).map(ROW[kind]),
        truncated: rows.length > limit,
    };
}

module.exports = { parseLookupsBody, getLookups };
