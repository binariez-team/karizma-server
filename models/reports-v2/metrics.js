const pool = require("../../config/database");
const { toCents, toMoney, pct, roundHalfAway } = require("./money");

// Canonical metrics of the reports (plan §3.4): one SQL definition per figure, shared by
// every page, so Inventory, the Balance sheet (Phase 4) and Financial (Phase 3) can
// never disagree about on-hand, stock value, pending deliveries, cash or receivables.
//
// - Every statement starts with its /* rk:... */ marker (the test harness routes on it)
//   and binds `database_id IN (?)` to the scope's tenant list T: a non-empty array of
//   validated ids from resolveScope.
// - SQL text is constant. The only variable fragment is filterSql()'s, assembled from
//   fixed strings; every value is bound.
// - Rows leave here normalised: ids and quantities as JS integers, money as integer
//   cents (money.js). The pool hands SUM()/DECIMAL back as strings, TINYINT(1) as
//   booleans, EXISTS and boolean expressions as numbers, DATETIME as
//   'YYYY-MM-DD HH:mm:ss' strings (config/database.js).

// TINYINT(1) arrives as a boolean, EXISTS / comparisons as 0/1
const flag = (v) => Boolean(Number(v));
const idOrNull = (v) => (v === null || v === undefined ? null : Number(v));

/** Map key of a (tenant, product) pair, for merging the side queries. */
const key = (databaseId, productId) => `${databaseId}:${productId}`;

/** num / den with 1 decimal, rounded half away from zero; null when den is 0. */
const oneDecimal = (num, den) => (den ? roundHalfAway((num * 10) / den) / 10 : null);

/**
 * Run async thunks with at most `limit` in flight: the POS pool has 10 connections and
 * a report never holds more than 4 (plan §3.1). Resolves to the results in input order.
 * On the first error nothing new is started and the error is thrown.
 */
async function runLimited(thunks, limit = 4) {
    const results = new Array(thunks.length);
    let next = 0;
    let failed = false;
    const worker = async () => {
        while (!failed && next < thunks.length) {
            const i = next++;
            try {
                results[i] = await thunks[i]();
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };
    const workers = Math.min(limit, thunks.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}

// ---------------------------------------------------------------- product filter

// The page's product filter (category, brand, name/SKU search) is evaluated as a 0/1
// column rather than a WHERE: the lists and KPIs keep only in_filter rows, while the
// exposure figures (D7) still see the whole shop (D-P2-1). COALESCE turns NULL (a NULL
// category, brand or sku that did not match) into 0.
const FILTER_PARTS = {
    category: "p.category_id_fk = ?",
    brand: "p.brand_id_fk = ?",
    search: "(p.product_name LIKE ? OR p.sku LIKE ?)",
};

/**
 * `${expr} AS in_filter` and its bind values, for SQL where `p` is products. The params
 * come in the order of the fragments; `pattern` is validate.search()'s escaped LIKE.
 *
 * @returns {{ expr: string, params: Array<number|string> }}
 */
function filterSql({ categoryId = null, brandId = null, pattern = null } = {}) {
    const parts = [];
    const params = [];
    if (categoryId != null) {
        parts.push(FILTER_PARTS.category);
        params.push(categoryId);
    }
    if (brandId != null) {
        parts.push(FILTER_PARTS.brand);
        params.push(brandId);
    }
    if (pattern != null) {
        parts.push(FILTER_PARTS.search);
        params.push(pattern, pattern);
    }
    return {
        expr: parts.length ? `COALESCE((${parts.join(" AND ")}), 0)` : "1",
        params,
    };
}

// ---------------------------------------------------------------- stock (M16–M19)

// One row per (tenant, live product) that has a live inventory row, so products with no
// ledger rows still appear (morexa started FROM the ledger and missed them). The latest
// live row wins: duplicates exist, there is no unique key (DeliverModel). on_hand = M16
// (every ledger type; REVALUE rows are 0); unit_cost = M17 (A10). Stock of a deleted
// product is gone from every figure (S7). The admin tenant's latest live row of the same
// product (ax / ai, same MAX(record_id) rule) carries his prices for the M19 fallback
// (S5); its bind is the admin tenant, not T.
const BASE_SQL = (expr) => `/* rk:inventory.base */
SELECT i.database_id, i.product_id_fk AS product_id, p.product_name, p.sku,
       p.category_id_fk AS category_id, c.category_name, p.brand_id_fk AS brand_id,
       COALESCE(oh.q, 0) AS on_hand,
       COALESCE(NULLIF(i.avg_cost_usd,0), i.unit_cost_usd, 0) AS unit_cost,
       i.unit_price_usd, i.whole_price_usd, i.grandwhole_price_usd, i.low_stock_threshold, i.show_on_sell_page,
       ai.unit_price_usd AS admin_unit_price_usd, ai.whole_price_usd AS admin_whole_price_usd,
       ai.grandwhole_price_usd AS admin_grandwhole_price_usd,
       ${expr} AS in_filter
FROM (SELECT MAX(record_id) AS rid FROM inventory
      WHERE is_deleted = 0 AND database_id IN (?) GROUP BY product_id_fk, database_id) ix
JOIN inventory i ON i.record_id = ix.rid
JOIN products p ON p.product_id = i.product_id_fk AND p.is_deleted = 0
LEFT JOIN products_categories c ON c.category_id = p.category_id_fk
LEFT JOIN (SELECT database_id, product_id_fk, SUM(quantity) AS q FROM inventory_transactions
           WHERE database_id IN (?) AND is_deleted = 0 GROUP BY database_id, product_id_fk) oh
       ON oh.database_id = i.database_id AND oh.product_id_fk = i.product_id_fk
LEFT JOIN (SELECT MAX(record_id) AS rid, product_id_fk FROM inventory
           WHERE is_deleted = 0 AND database_id IN (?) GROUP BY product_id_fk) ax
       ON ax.product_id_fk = i.product_id_fk
LEFT JOIN inventory ai ON ai.record_id = ax.rid`;

/**
 * M19 sale price per unit, in cents, for one basis (S5): a user shop's price of 0 or
 * NULL is replaced by the admin's current price for the same basis; the admin's own
 * rows never fall back. An admin price of 0 / NULL stays 0 (ZERO_PRICE_STOCK).
 */
function salePrice(own, admin, mayFallBack) {
    const c = toCents(own);
    if (c !== 0 || !mayFallBack) return { c, fallback: false };
    const a = toCents(admin);
    return { c: a, fallback: a !== 0 };
}

/**
 * The stock base dataset of T. Money in cents per unit; on_hand signed (negative stock
 * exists, sales do not check stock). hidden_on_sell is the sell page's own rule
 * (show_on_sell_page = 0). retail_c / wholesale_c / grand_c are the M19 prices after
 * the admin-price fallback (S5); admin_priced: at least one of them took the admin's
 * price. `adminDb` is the admin tenant, or null when there is none (no fallback).
 */
async function liveBase(T, filter, adminDb) {
    const [rows] = await pool.query(BASE_SQL(filter.expr), [
        ...filter.params,
        T,
        T,
        [adminDb ?? 0], // 0 matches no tenant
    ]);
    return rows.map((r) => {
        const db = Number(r.database_id);
        const mayFallBack = adminDb !== null && adminDb !== undefined && db !== adminDb;
        const retail = salePrice(r.unit_price_usd, r.admin_unit_price_usd, mayFallBack);
        const wholesale = salePrice(r.whole_price_usd, r.admin_whole_price_usd, mayFallBack);
        const grand = salePrice(r.grandwhole_price_usd, r.admin_grandwhole_price_usd, mayFallBack);
        return {
            database_id: db,
            product_id: Number(r.product_id),
            product_name: r.product_name,
            sku: r.sku ?? null,
            category_id: idOrNull(r.category_id),
            category_name: r.category_name ?? null,
            brand_id: idOrNull(r.brand_id),
            on_hand: Number(r.on_hand),
            unit_cost_c: toCents(r.unit_cost),
            retail_c: retail.c,
            wholesale_c: wholesale.c,
            grand_c: grand.c,
            admin_priced: retail.fallback || wholesale.fallback || grand.fallback,
            threshold: idOrNull(r.low_stock_threshold),
            hidden_on_sell: !flag(r.show_on_sell_page),
            in_filter: flag(r.in_filter),
        };
    });
}

// ---------------------------------------------------------------- sales side (M26, F_S)

// M26: from the sales documents, not the ledger, because a deleted sale keeps its SALE
// ledger rows (SellOrdersModel.deleteOrder)
const LAST_SALE_SQL = `/* rk:metrics.last_sale */
SELECT so.database_id, soi.product_id, MAX(so.order_datetime) AS last_sale
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
WHERE so.database_id IN (?) AND so.is_deleted = 0 GROUP BY so.database_id, soi.product_id`;

/** Map key(db, product) → last sale datetime (Beirut). */
async function lastSales(T) {
    const [rows] = await pool.query(LAST_SALE_SQL, [T]);
    return new Map(rows.map((r) => [key(r.database_id, r.product_id), r.last_sale]));
}

// F_S over [lo, hi): units, invoices (distinct orders, S8) and sales value per (tenant,
// product), from the lines (never the header total)
const WINDOW_SALES_SQL = `/* rk:metrics.window_sales */
SELECT so.database_id, soi.product_id, SUM(soi.quantity) AS units_sold, COUNT(DISTINCT so.order_id) AS orders,
       ROUND(SUM(soi.quantity * COALESCE(soi.unit_price,0)),2) AS sales_value
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?
GROUP BY so.database_id, soi.product_id`;

/** Map key(db, product) → { units_sold, orders, sales_c } over the half-open window. */
async function windowSales(T, lo, hi) {
    const [rows] = await pool.query(WINDOW_SALES_SQL, [T, lo, hi]);
    return new Map(
        rows.map((r) => [
            key(r.database_id, r.product_id),
            {
                units_sold: Number(r.units_sold ?? 0),
                orders: Number(r.orders ?? 0),
                sales_c: toCents(r.sales_value),
            },
        ]),
    );
}

// ---------------------------------------------------------------- receipts (M27)

// Ledger stamps: the server clock (UTC on production, LEDGER_CLOCK), fine at day
// precision. A delivery's receipt is its approval (RECEIPT_IS_APPROVAL).
const RECEIPTS_SQL = `/* rk:metrics.receipts */
SELECT database_id, product_id_fk, MIN(transaction_datetime) AS first_receipt, MAX(transaction_datetime) AS last_receipt
FROM inventory_transactions WHERE database_id IN (?) AND is_deleted = 0 AND quantity > 0
  AND transaction_type IN ('SUPPLY','DELIVER','ADD') GROUP BY database_id, product_id_fk`;

/** Map key(db, product) → { first_receipt, last_receipt }. */
async function receipts(T) {
    const [rows] = await pool.query(RECEIPTS_SQL, [T]);
    return new Map(
        rows.map((r) => [
            key(r.database_id, r.product_id_fk),
            { first_receipt: r.first_receipt, last_receipt: r.last_receipt },
        ]),
    );
}

// ---------------------------------------------------------------- pending deliveries (M23, M24)

// M23 at line level, so a product filter can apply to in-transit lines (D-P2-6); the
// caller adds the lines up per order, in cents. Value chain = approval's
// (UserHistoryModel.approve): the dispatch snapshot, else the sender's live avg, else
// his unit cost, else the note price. The sender's row (sx) is read by design, whatever
// T is: it is the cost the receiver will book on approval. A line of a deleted product
// is left out: its stock counts nowhere, before or after approval (S7).
const PENDING_LINES_SQL = (expr) => `/* rk:metrics.pending_lines */
SELECT d.order_id, d.invoice_number, d.order_datetime, d.database_id AS receiver_id, d.admin_id_fk AS sender_id,
       di.product_id, di.quantity AS units,
       ROUND(di.quantity * COALESCE(NULLIF(di.avg_cost_usd,0), NULLIF(si.avg_cost_usd,0),
                                    NULLIF(si.unit_cost_usd,0), di.unit_price), 2) AS value_cost,
       (di.avg_cost_usd IS NULL) AS legacy_line,
       ${expr} AS in_filter
FROM deliver_orders d
JOIN deliver_order_items di ON di.order_id_fk = d.order_id AND di.is_deleted = 0
JOIN products p ON p.product_id = di.product_id AND p.is_deleted = 0
LEFT JOIN (SELECT MAX(record_id) rid, product_id_fk, database_id FROM inventory
           WHERE is_deleted = 0 GROUP BY product_id_fk, database_id) sx
       ON sx.product_id_fk = di.product_id AND sx.database_id = d.admin_id_fk
LEFT JOIN inventory si ON si.record_id = sx.rid
WHERE d.is_approved = 0 AND d.is_deleted = 0 AND (d.database_id IN (?) OR d.admin_id_fk IN (?))`;

/** Lines of the deliveries awaiting approval that T sends or receives. */
async function pendingLines(T, filter) {
    const [rows] = await pool.query(PENDING_LINES_SQL(filter.expr), [
        ...filter.params,
        T,
        T,
    ]);
    return rows.map((r) => ({
        order_id: Number(r.order_id),
        invoice_number: r.invoice_number ?? null,
        order_datetime: r.order_datetime,
        receiver_id: Number(r.receiver_id),
        sender_id: Number(r.sender_id),
        product_id: Number(r.product_id),
        units: Number(r.units),
        value_c: toCents(r.value_cost),
        legacy: flag(r.legacy_line),
        in_filter: flag(r.in_filter),
    }));
}

// ---------------------------------------------------------------- money (M20, M21)

// M20, keyed on journal_items.database_id: a confirmed transfer's receiver line sits on
// the sender's voucher (TransferModel). Same basis as GET /balance.
const CASH_SQL = `/* rk:metrics.cash */
SELECT ji.database_id,
       ROUND(SUM(CASE WHEN ji.account_id_fk = ? THEN ji.debit - ji.credit ELSE 0 END),2) AS cash,
       ROUND(SUM(CASE WHEN ji.account_id_fk = ? THEN ji.debit - ji.credit ELSE 0 END),2) AS whish
FROM journal_items ji
WHERE ji.database_id IN (?) AND ji.is_deleted = 0 AND ji.account_id_fk IN (?, ?)
GROUP BY ji.database_id`;

/** Map db → { cash_c, whish_c } (signed), ids from accounts.getAccountIds(). */
async function cashWhish(T, ids) {
    const [rows] = await pool.query(CASH_SQL, [ids.a531, ids.a532, T, ids.a531, ids.a532]);
    return new Map(
        rows.map((r) => [
            Number(r.database_id),
            { cash_c: toCents(r.cash), whish_c: toCents(r.whish) },
        ]),
    );
}

// M21 per-customer balances as of now, scoped by the voucher's tenant. Deleted customers
// are left out, as on the Debts screen (accounts.is_deleted = 0, CustomersModel
// getCustomerDebts; S6).
const RECEIVABLES_SQL = `/* rk:metrics.receivables */
SELECT jv.database_id, ji.partner_id_fk, ROUND(SUM(ji.debit - ji.credit),2) AS bal
FROM journal_items ji
JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk AND jv.is_deleted = 0
JOIN accounts a ON a.account_id = ji.partner_id_fk AND a.is_customer = 1 AND a.is_deleted = 0
WHERE jv.database_id IN (?) AND ji.is_deleted = 0
GROUP BY jv.database_id, ji.partner_id_fk`;

/**
 * Map db → { receivables_c (Σ positive balances), credits_c (Σ negative balances, as a
 * positive amount), debtors (customers owing) }, live customers only (S6).
 */
async function receivables(T) {
    const [rows] = await pool.query(RECEIVABLES_SQL, [T]);
    const byTenant = new Map();
    for (const r of rows) {
        const db = Number(r.database_id);
        let t = byTenant.get(db);
        if (!t) {
            t = { receivables_c: 0, credits_c: 0, debtors: 0 };
            byTenant.set(db, t);
        }
        const bal = toCents(r.bal);
        if (bal > 0) {
            t.receivables_c += bal;
            t.debtors += 1;
        } else if (bal < 0) {
            t.credits_c -= bal;
        }
    }
    return byTenant;
}

// ---------------------------------------------------------------- supplier balances (M22)

// M22 per supplier, keyed on journal_items.database_id: admin only in practice (purchases
// and supplier payments are admin routes). Same basis as
// SuppliersModel.getSupplierTotalBalance: credit − debit, only ji.is_deleted filtered.
// Deleted suppliers are left out, as on the Suppliers screen (accounts.is_deleted = 0,
// SuppliersModel.getAllSuppliers; S10). Cash paid to them stays in M20 (it left the till).
const SUPPLIER_BALANCES_SQL = `/* rk:metrics.supplier_balances */
SELECT ji.database_id, ji.partner_id_fk, ROUND(SUM(ji.credit - ji.debit),2) AS bal
FROM journal_items ji
JOIN accounts a ON a.account_id = ji.partner_id_fk AND a.is_supplier = 1 AND a.is_deleted = 0
WHERE ji.database_id IN (?) AND ji.is_deleted = 0
GROUP BY ji.database_id, ji.partner_id_fk`;

/**
 * Map db → { payables_c (Σ positive balances: owed to suppliers), advances_c (Σ negative
 * balances, as a positive amount: paid to suppliers ahead) }, live suppliers only (S10).
 */
async function supplierBalances(T) {
    const [rows] = await pool.query(SUPPLIER_BALANCES_SQL, [T]);
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

// M20 as of two cuts (M20-AT): opening at :lo and closing at :hi in one pass, by the
// voucher date. Like M20 and the cash-flow query it filters only ji.is_deleted, so
// opening + flows = closing exactly and the closing at today = GET /balance.
const CASH_AT_SQL = `/* rk:metrics.cash_at */
SELECT ji.database_id,
       ROUND(SUM(CASE WHEN ji.account_id_fk = ? AND jv.journal_date < ? THEN ji.debit - ji.credit ELSE 0 END),2) AS open_cash,
       ROUND(SUM(CASE WHEN ji.account_id_fk = ? AND jv.journal_date < ? THEN ji.debit - ji.credit ELSE 0 END),2) AS open_whish,
       ROUND(SUM(CASE WHEN ji.account_id_fk = ? AND jv.journal_date < ? THEN ji.debit - ji.credit ELSE 0 END),2) AS close_cash,
       ROUND(SUM(CASE WHEN ji.account_id_fk = ? AND jv.journal_date < ? THEN ji.debit - ji.credit ELSE 0 END),2) AS close_whish
FROM journal_items ji JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
WHERE ji.database_id IN (?) AND ji.is_deleted = 0 AND ji.account_id_fk IN (?, ?)
GROUP BY ji.database_id`;

/**
 * Map db → { open: { cash_c, whish_c }, close: { cash_c, whish_c } } (signed), the cash
 * and whish held before `lo` and before `hi`.
 */
async function cashAt(T, ids, lo, hi) {
    const [rows] = await pool.query(CASH_AT_SQL, [
        ids.a531, lo, ids.a532, lo, ids.a531, hi, ids.a532, hi,
        T, ids.a531, ids.a532,
    ]);
    return new Map(
        rows.map((r) => [
            Number(r.database_id),
            {
                open: { cash_c: toCents(r.open_cash), whish_c: toCents(r.open_whish) },
                close: { cash_c: toCents(r.close_cash), whish_c: toCents(r.close_whish) },
            },
        ]),
    );
}

// M21 per customer as of two cuts, :lo and :hi, in one pass (same filters as M21: live
// customers only, S6). Lines with no voucher date before a cut are not in its balance.
const RECEIVABLES_AT_SQL = `/* rk:metrics.receivables_at */
SELECT jv.database_id, ji.partner_id_fk,
       ROUND(SUM(CASE WHEN jv.journal_date < ? THEN ji.debit - ji.credit ELSE 0 END),2) AS open_bal,
       ROUND(SUM(CASE WHEN jv.journal_date < ? THEN ji.debit - ji.credit ELSE 0 END),2) AS close_bal
FROM journal_items ji
JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk AND jv.is_deleted = 0
JOIN accounts a ON a.account_id = ji.partner_id_fk AND a.is_customer = 1 AND a.is_deleted = 0
WHERE jv.database_id IN (?) AND ji.is_deleted = 0
GROUP BY jv.database_id, ji.partner_id_fk`;

const emptyBalances = () => ({ net_c: 0, receivables_c: 0, credits_c: 0, debtors: 0 });

/**
 * Map db → { open, close }, each { net_c (signed Σ of the customer balances),
 * receivables_c (Σ positive), credits_c (Σ negative, as a positive amount), debtors
 * (customers owing) } at that cut.
 */
async function receivablesAt(T, lo, hi) {
    const [rows] = await pool.query(RECEIVABLES_AT_SQL, [lo, hi, T]);
    const byTenant = new Map();
    const add = (side, bal) => {
        side.net_c += bal;
        if (bal > 0) {
            side.receivables_c += bal;
            side.debtors += 1;
        } else if (bal < 0) {
            side.credits_c -= bal;
        }
    };
    for (const r of rows) {
        const db = Number(r.database_id);
        let t = byTenant.get(db);
        if (!t) {
            t = { open: emptyBalances(), close: emptyBalances() };
            byTenant.set(db, t);
        }
        add(t.open, toCents(r.open_bal));
        add(t.close, toCents(r.close_bal));
    }
    return byTenant;
}

// ---------------------------------------------------------------- pending transfers (M25)

// As of now. The sender's cash is already credited (TransferModel.create); the
// receiver's is debited only on confirm.
const PENDING_TRANSFERS_SQL = `/* rk:metrics.pending_transfers */
SELECT transfer_id, transfer_number, transfer_datetime, amount, money_account, from_database_id, to_database_id
FROM money_transfers
WHERE is_approved = 0 AND is_deleted = 0 AND (from_database_id IN (?) OR to_database_id IN (?))
ORDER BY transfer_datetime, transfer_id`;

/** The transfers awaiting confirmation that T sends or receives, oldest first. */
async function pendingTransfers(T) {
    const [rows] = await pool.query(PENDING_TRANSFERS_SQL, [T, T]);
    return rows.map((r) => ({
        transfer_id: Number(r.transfer_id),
        transfer_number: r.transfer_number ?? null,
        transfer_datetime: r.transfer_datetime,
        amount_c: toCents(r.amount),
        money_account: String(r.money_account),
        from_database_id: Number(r.from_database_id),
        to_database_id: Number(r.to_database_id),
    }));
}

// ---------------------------------------------------------------- P&L components (M1–M13)

// The DATE_FORMAT patterns a bucketed query may group by: dates.granularity().sql, or
// months ('%Y-%m', the settlement dues). Anything else is a bug, never input.
const BUCKET_FORMATS = new Set(["%Y-%m-%d %H:00", "%Y-%m-%d", "%Y-%m"]);
const bucketFormat = (fmt) => {
    if (!BUCKET_FORMATS.has(fmt)) throw new Error(`Unknown bucket format: ${fmt}`);
    return fmt;
};

// M1, M2, M11, M12 inputs and M13 under F_S, from the lines (never the header total, nor
// the header total_cost). Cost per line = LINE_COST: the avg-cost snapshot, else the
// line's unit cost (the legacy Revenue chain). fallback_lines counts the lines costed
// that way (COST_FALLBACK_LINES); it never goes into a payload.
const SALES_SQL = `/* rk:metrics.sales */
SELECT so.database_id, COUNT(DISTINCT so.order_id) AS orders, SUM(soi.quantity) AS units_sold,
       ROUND(SUM(soi.quantity * COALESCE(soi.unit_price,0)),2) AS sales,
       ROUND(SUM(soi.quantity * COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0)),2) AS cogs,
       ROUND(SUM(CASE WHEN so.customer_id IS NULL THEN soi.quantity * COALESCE(soi.unit_price,0) ELSE 0 END),2) AS cash_sales,
       COUNT(DISTINCT so.customer_id) AS customers_served,
       SUM(COALESCE(soi.avg_cost,0) = 0) AS fallback_lines
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?
GROUP BY so.database_id`;

const SALES_BUCKETS_SQL = `/* rk:metrics.sales_buckets */
SELECT so.database_id, DATE_FORMAT(so.order_datetime, ?) AS bucket,
       ROUND(SUM(soi.quantity * COALESCE(soi.unit_price,0)),2) AS sales,
       ROUND(SUM(soi.quantity * COALESCE(NULLIF(soi.avg_cost,0), soi.unit_cost, 0)),2) AS cogs
FROM sales_orders so JOIN sales_order_items soi ON soi.order_id = so.order_id AND soi.is_deleted = 0
WHERE so.database_id IN (?) AND so.is_deleted = 0 AND so.order_datetime >= ? AND so.order_datetime < ?
GROUP BY so.database_id, bucket`;

/**
 * Sales over [lo, hi). Without `fmt`: one row per tenant { database_id, orders,
 * units_sold, sales_c, cogs_c, cash_sales_c, customers_served, fallback_lines }. With
 * `fmt` (a DATE_FORMAT pattern of BUCKET_FORMATS): one row per tenant and bucket
 * { database_id, bucket, sales_c, cogs_c }.
 */
async function salesTotals(T, lo, hi, fmt) {
    if (fmt !== undefined) {
        const [rows] = await pool.query(SALES_BUCKETS_SQL, [bucketFormat(fmt), T, lo, hi]);
        return rows.map((r) => ({
            database_id: Number(r.database_id),
            bucket: String(r.bucket),
            sales_c: toCents(r.sales),
            cogs_c: toCents(r.cogs),
        }));
    }
    const [rows] = await pool.query(SALES_SQL, [T, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        orders: Number(r.orders ?? 0),
        units_sold: Number(r.units_sold ?? 0),
        sales_c: toCents(r.sales),
        cogs_c: toCents(r.cogs),
        cash_sales_c: toCents(r.cash_sales),
        customers_served: Number(r.customers_served ?? 0),
        fallback_lines: Number(r.fallback_lines ?? 0),
    }));
}

// M3, M4 under F_R, scoped on ro.database_id. A return is costed at the shop's average
// on the day of the return (RETURN_COST_CURRENT_AVG).
const RETURNS_SQL = `/* rk:metrics.returns */
SELECT ro.database_id, COUNT(DISTINCT ro.order_id) AS returns_count, SUM(roi.quantity) AS units_returned,
       ROUND(SUM(roi.quantity * COALESCE(roi.unit_price,0)),2) AS returns_value,
       ROUND(SUM(roi.quantity * COALESCE(NULLIF(roi.avg_cost,0), roi.unit_cost, 0)),2) AS returns_cost
FROM return_orders ro JOIN return_order_items roi ON roi.order_id = ro.order_id AND roi.is_deleted = 0
WHERE ro.database_id IN (?) AND ro.is_deleted = 0 AND ro.order_datetime >= ? AND ro.order_datetime < ?
GROUP BY ro.database_id`;

const RETURNS_BUCKETS_SQL = `/* rk:metrics.returns_buckets */
SELECT ro.database_id, DATE_FORMAT(ro.order_datetime, ?) AS bucket,
       ROUND(SUM(roi.quantity * COALESCE(roi.unit_price,0)),2) AS returns_value,
       ROUND(SUM(roi.quantity * COALESCE(NULLIF(roi.avg_cost,0), roi.unit_cost, 0)),2) AS returns_cost
FROM return_orders ro JOIN return_order_items roi ON roi.order_id = ro.order_id AND roi.is_deleted = 0
WHERE ro.database_id IN (?) AND ro.is_deleted = 0 AND ro.order_datetime >= ? AND ro.order_datetime < ?
GROUP BY ro.database_id, bucket`;

/**
 * Returns over [lo, hi), by their own document date. Without `fmt`: per tenant
 * { database_id, returns_count, units_returned, returns_c, rcost_c }; with `fmt`: per
 * tenant and bucket { database_id, bucket, returns_c, rcost_c }.
 */
async function returnsTotals(T, lo, hi, fmt) {
    if (fmt !== undefined) {
        const [rows] = await pool.query(RETURNS_BUCKETS_SQL, [bucketFormat(fmt), T, lo, hi]);
        return rows.map((r) => ({
            database_id: Number(r.database_id),
            bucket: String(r.bucket),
            returns_c: toCents(r.returns_value),
            rcost_c: toCents(r.returns_cost),
        }));
    }
    const [rows] = await pool.query(RETURNS_SQL, [T, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        returns_count: Number(r.returns_count ?? 0),
        units_returned: Number(r.units_returned ?? 0),
        returns_c: toCents(r.returns_value),
        rcost_c: toCents(r.returns_cost),
    }));
}

// M8 from the dispose lines (each line's unit_cost = the avg at the time), not the
// header total_cost
const DISPOSALS_SQL = `/* rk:metrics.disposals */
SELECT dp.database_id, ROUND(SUM(dpi.quantity * COALESCE(dpi.unit_cost,0)),2) AS disposed
FROM dispose_products dp JOIN dispose_products_items dpi ON dpi.dispose_id = dp.dispose_id AND dpi.is_deleted = 0
WHERE dp.database_id IN (?) AND dp.is_deleted = 0 AND dp.dispose_datetime >= ? AND dp.dispose_datetime < ?
GROUP BY dp.database_id`;

const DISPOSALS_BUCKETS_SQL = `/* rk:metrics.disposals_buckets */
SELECT dp.database_id, DATE_FORMAT(dp.dispose_datetime, ?) AS bucket,
       ROUND(SUM(dpi.quantity * COALESCE(dpi.unit_cost,0)),2) AS disposed
FROM dispose_products dp JOIN dispose_products_items dpi ON dpi.dispose_id = dp.dispose_id AND dpi.is_deleted = 0
WHERE dp.database_id IN (?) AND dp.is_deleted = 0 AND dp.dispose_datetime >= ? AND dp.dispose_datetime < ?
GROUP BY dp.database_id, bucket`;

/** Disposals at cost over [lo, hi): per tenant { database_id, disposed_c } (+ bucket with fmt). */
async function disposals(T, lo, hi, fmt) {
    const bucketed = fmt !== undefined;
    const [rows] = bucketed
        ? await pool.query(DISPOSALS_BUCKETS_SQL, [bucketFormat(fmt), T, lo, hi])
        : await pool.query(DISPOSALS_SQL, [T, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        ...(bucketed ? { bucket: String(r.bucket) } : {}),
        disposed_c: toCents(r.disposed),
    }));
}

// M9: EXP vouchers on the poster's tenant (jv.database_id), by voucher date
const EXPENSES_SQL = `/* rk:metrics.expenses */
SELECT jv.database_id, ROUND(SUM(jv.total_value),2) AS expenses, COUNT(*) AS n
FROM journal_vouchers jv
WHERE jv.database_id IN (?) AND jv.is_deleted = 0 AND jv.journal_number LIKE 'EXP%'
  AND jv.journal_date >= ? AND jv.journal_date < ?
GROUP BY jv.database_id`;

const EXPENSES_BUCKETS_SQL = `/* rk:metrics.expenses_buckets */
SELECT jv.database_id, DATE_FORMAT(jv.journal_date, ?) AS bucket, ROUND(SUM(jv.total_value),2) AS expenses, COUNT(*) AS n
FROM journal_vouchers jv
WHERE jv.database_id IN (?) AND jv.is_deleted = 0 AND jv.journal_number LIKE 'EXP%'
  AND jv.journal_date >= ? AND jv.journal_date < ?
GROUP BY jv.database_id, bucket`;

/** Expenses over [lo, hi): per tenant { database_id, expenses_c, count } (+ bucket with `fmt`). */
async function expenses(T, lo, hi, fmt) {
    const bucketed = fmt !== undefined;
    const [rows] = bucketed
        ? await pool.query(EXPENSES_BUCKETS_SQL, [bucketFormat(fmt), T, lo, hi])
        : await pool.query(EXPENSES_SQL, [T, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        ...(bucketed ? { bucket: String(r.bucket) } : {}),
        expenses_c: toCents(r.expenses),
        count: Number(r.n ?? 0),
    }));
}

// M35: the admin's unknown cash losses (CLS vouchers, Dr 658 / Cr till) and gains (CGN
// vouchers, Dr till / Cr 758) on the poster's tenant, by voucher date: part of M10 (owner
// decision C1, 2026-10-22), mirroring M9. The caller binds the ADMIN tenant only (C2: only
// his shop carries corrections), so no user's split, earned share (M31) or cap moves.
const CASH_DIFFERENCES_SQL = `/* rk:metrics.cash_differences */
SELECT jv.database_id,
       ROUND(SUM(CASE WHEN jv.journal_number LIKE 'CLS%' THEN jv.total_value ELSE 0 END),2) AS unknown_loss,
       ROUND(SUM(CASE WHEN jv.journal_number LIKE 'CGN%' THEN jv.total_value ELSE 0 END),2) AS unknown_gain,
       COUNT(*) AS n
FROM journal_vouchers jv
WHERE jv.database_id IN (?) AND jv.is_deleted = 0
  AND (jv.journal_number LIKE 'CLS%' OR jv.journal_number LIKE 'CGN%')
  AND jv.journal_date >= ? AND jv.journal_date < ?
GROUP BY jv.database_id`;

/** Unknown cash loss / gain over [lo, hi): per tenant { database_id, loss_c, gain_c, count }. */
async function cashDifferences(T, lo, hi) {
    const [rows] = await pool.query(CASH_DIFFERENCES_SQL, [T, lo, hi]);
    return rows.map((r) => ({
        database_id: Number(r.database_id),
        loss_c: toCents(r.unknown_loss),
        gain_c: toCents(r.unknown_gain),
        count: Number(r.n ?? 0),
    }));
}

// M36: cash outside the till (533: the safe, the bank, the owner's hands; §7.8), the
// balance of the admin's to_safe / from_safe corrections and of his opening safe balance
// (SOB, Dr 533 / Cr 101, owner answer F2: by its own date). Business money: an asset of the
// Balance sheet, never part of Cash / Whish (M20, GET /balance) nor of the cap (M30).
// Same line filters as M20 (ji.is_deleted only); the month-end form cuts by voucher date
// like M20-AT.
const OUTSIDE_TILL_SQL = `/* rk:metrics.outside_till */
SELECT ji.database_id, ROUND(SUM(ji.debit - ji.credit),2) AS outside_till
FROM journal_items ji
WHERE ji.database_id IN (?) AND ji.is_deleted = 0 AND ji.account_id_fk = ?
GROUP BY ji.database_id`;

const OUTSIDE_TILL_AT_SQL = `/* rk:metrics.outside_till_at */
SELECT ji.database_id, ROUND(SUM(ji.debit - ji.credit),2) AS outside_till
FROM journal_items ji JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
WHERE ji.database_id IN (?) AND ji.is_deleted = 0 AND ji.account_id_fk = ?
  AND jv.journal_date < ?
GROUP BY ji.database_id`;

/**
 * Map db → cash outside the till in cents (signed), now, or before `cut` when given.
 * Empty, with no statement, while the chart has no 533 (§7.8 not run: nothing can be
 * posted to it).
 */
async function outsideTill(T, ids, cut = null) {
    if (ids.a533 === null || ids.a533 === undefined) return new Map();
    const [rows] =
        cut === null
            ? await pool.query(OUTSIDE_TILL_SQL, [T, ids.a533])
            : await pool.query(OUTSIDE_TILL_AT_SQL, [T, ids.a533, cut]);
    return new Map(rows.map((r) => [Number(r.database_id), toCents(r.outside_till)]));
}

// ---------------------------------------------------------------- exposure (M30)

/**
 * What a user's shop holds, in cents (M30's gross sum): cash and whish (signed),
 * receivables (positive balances), stock at cost and pending incoming deliveries.
 * Pending incoming transfers are not part of it (A6).
 */
const holdings = ({ cash_c = 0, whish_c = 0, receivables_c = 0, stock_c = 0, pending_in_c = 0 }) =>
    cash_c + whish_c + receivables_c + stock_c + pending_in_c;

/**
 * Assets-cap usage of one user's shop (M30, D6, D7): holdings() less the user's untaken
 * profit share (M33, `untaken_c`, Phase 7.1 part F, O6): only his own money is his, so
 * a negative untaken share (overdrawn) adds to it, and the result can go below 0 (the
 * admin holds part of his share: status 'ok', the % signed). `untaken_c` defaults to 0
 * (the admin's own tenant has none). `cap` is the user_database.assets_cap_usd DECIMAL
 * string, or null for no cap.
 *
 * Status, on the net figure: no cap → 'no_cap'; a 0.00 cap → 'over' as soon as anything
 * is held; else 'over' above the cap, 'warn' from 80 %, 'ok' below. exposure_pct is null
 * with no cap and with a 0.00 cap.
 */
function exposure(segments) {
    const { untaken_c = 0, cap = null } = segments;
    const used = holdings(segments) - untaken_c;
    const capC = cap === null || cap === undefined ? null : toCents(cap);

    let status;
    if (capC === null) status = "no_cap";
    else if (capC === 0) status = used > 0 ? "over" : "ok";
    else if (used > capC) status = "over";
    else if (used * 100 >= capC * 80) status = "warn";
    else status = "ok";

    return {
        exposure_used: toMoney(used),
        exposure_pct: capC ? pct(used, capC) : null,
        exposure_status: status,
    };
}

/**
 * M30 in full (the Balance sheet, the deliver cap check): exposure() plus the headroom,
 * cap − used (negative when over; null with no cap), the negative-cash flag (cash or
 * whish below zero; both stay signed in exposure_used) and the Phase 7.1 parts:
 * holdings_cost (the gross sum before the untaken share), untaken_profit_share (M33,
 * signed) and cap_after_profit_share (cap + untaken: where the bar's cap marker sits,
 * since the bar draws the gross holdings; null with no cap).
 */
function exposureDetail(segments) {
    const { cash_c = 0, whish_c = 0, untaken_c = 0, cap = null } = segments;
    const e = exposure(segments);
    const capC = cap === null || cap === undefined ? null : toCents(cap);
    return {
        exposure_used: e.exposure_used,
        exposure_pct: e.exposure_pct,
        exposure_headroom: capC === null ? null : toMoney(capC - toCents(e.exposure_used)),
        exposure_status: e.exposure_status,
        negative_cash: cash_c < 0 || whish_c < 0,
        holdings_cost: toMoney(holdings(segments)),
        untaken_profit_share: toMoney(untaken_c),
        cap_after_profit_share: capC === null ? null : toMoney(capC + untaken_c),
    };
}

module.exports = {
    key,
    oneDecimal,
    runLimited,
    filterSql,
    liveBase,
    lastSales,
    windowSales,
    receipts,
    pendingLines,
    cashWhish,
    receivables,
    supplierBalances,
    holdings,
    exposure,
    exposureDetail,
    cashAt,
    receivablesAt,
    pendingTransfers,
    salesTotals,
    returnsTotals,
    disposals,
    expenses,
    cashDifferences,
    outsideTill,
};
