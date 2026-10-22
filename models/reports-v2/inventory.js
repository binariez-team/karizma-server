const pool = require("../../config/database");
const { int, intIn, bool, search } = require("./validate");
const { toMoney, asMoney, pct, roundHalfAway, bp } = require("./money");
const { nowBeirut, relativeWindows, daysBetween, monthOf } = require("./dates");
const { getAccountIds } = require("./accounts");
const M = require("./metrics");
const P = require("./partner");

// Inventory report: POST /reports/v2/inventory (plan §6.6, Phase 2).
//
// A snapshot as of now, with no date range. ONE base dataset (a row per tenant and live
// product with a live inventory row, plus its ledger on-hand) feeds every KPI and every
// list, so the cards and the tables cannot disagree. Everything is put together here in
// integer cents; the client never adds money up.
//
// - Value is max(on_hand, 0) × price: negative rows never add value, they are counted
//   (negative_rows, NEGATIVE_STOCK).
// - The category / brand / search filter is the base rows' `in_filter` flag. Every KPI,
//   list, by_tenant and by_shop figure uses the filtered rows; only the exposure columns
//   of by_shop see the whole shop (D-P2-1).
// - Restricted viewers (view_cost off, D8): the controller strips the cost keys. Here
//   Dead stock, Highest value and Value by category rank by retail value, the three
//   share percentages switch to retail, and the notes that only explain cost figures
//   are left out (D-P2-7).
// - Sale value (M19): a user shop's row with no price for a basis is valued at the
//   admin's price (S5, in metrics.liveBase), so every retail figure, margin and ranking
//   uses it. Deleted products and deleted customers count nowhere (S7, S6).
// - Cap used (by_shop, Combined only, so the admin only): M30 net of the user's untaken
//   profit share (Phase 7.1, O6; partner.js), with the gross holdings_cost and the
//   untaken_profit_share beside it.

const DEAD_DAYS = [30, 60, 90, 180];
const MOVER_DAYS = [7, 30, 90];
const LIST_ROWS = 200; // low, out, dead, in transit
const TOP_ROWS = 25; // fast movers, highest value
const CATEGORY_BARS = 15; // the rest is summed into by_category_other

const BASES = ["retail", "wholesale", "grand"];

/**
 * Read the request body (contract §3.1). Every field is checked before the scope is
 * resolved, so a bad body issues no SQL at all. Unknown keys are ignored.
 *
 * @returns {{ deadDays: number, moverDays: number, categoryId: number|null,
 *   brandId: number|null, search: string|null, pattern: string|null,
 *   includeHidden: boolean }}
 */
function parseInventoryBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const deadDays = intIn(b.dead_days, "dead_days", DEAD_DAYS, { def: 90 });
    const moverDays = intIn(b.mover_days, "mover_days", MOVER_DAYS, { def: 30 });
    const categoryId = int(b.category_id, "category_id", { min: 1, def: null });
    const brandId = int(b.brand_id, "brand_id", { min: 1, def: null });
    const pattern = search(b.search);
    const includeHidden = bool(b.include_hidden, "include_hidden");
    return {
        deadDays,
        moverDays,
        categoryId,
        brandId,
        // echoed back trimmed; the SQL only ever sees the escaped pattern
        search: pattern === null ? null : b.search.trim(),
        pattern,
        includeHidden,
    };
}

// ---------------------------------------------------------------- page-only SQL

// Data-quality notes: over T, whatever the filter (plan §6.6, SQL as given there).
// Deleted products count nowhere (S7), so their duplicate rows are not a note either.
const DUP_ROWS_SQL = `/* rk:inventory.dup_rows */
SELECT i.database_id, i.product_id_fk, COUNT(*) n FROM inventory i
JOIN products p ON p.product_id = i.product_id_fk AND p.is_deleted = 0
WHERE i.is_deleted = 0 AND i.database_id IN (?)
GROUP BY i.database_id, i.product_id_fk HAVING COUNT(*) > 1`;

// Ledger stock of a live product with no live inventory row: not in the base dataset,
// so not valued
const STOCK_WITHOUT_ROW_SQL = `/* rk:inventory.stock_without_row */
SELECT oh.database_id, COUNT(*) AS n
FROM (SELECT database_id, product_id_fk, SUM(quantity) q FROM inventory_transactions
      WHERE database_id IN (?) AND is_deleted = 0 GROUP BY database_id, product_id_fk HAVING SUM(quantity) <> 0) oh
JOIN products p ON p.product_id = oh.product_id_fk AND p.is_deleted = 0
LEFT JOIN inventory i ON i.product_id_fk = oh.product_id_fk AND i.database_id = oh.database_id AND i.is_deleted = 0
WHERE i.record_id IS NULL GROUP BY oh.database_id`;

// Restock hint for the admin looking at one user's shop: his OWN on-hand of the products
// on that shop's low-stock list. Binds the admin viewer's tenant, not T (D-P2-8).
const ADMIN_ON_HAND_SQL = `/* rk:inventory.admin_on_hand */
SELECT product_id_fk AS product_id, SUM(quantity) AS q FROM inventory_transactions
WHERE database_id IN (?) AND is_deleted = 0 AND product_id_fk IN (?) GROUP BY product_id_fk`;

async function duplicatePairs(T) {
    const [rows] = await pool.query(DUP_ROWS_SQL, [T]);
    return rows.length;
}

async function stockWithoutRow(T) {
    const [rows] = await pool.query(STOCK_WITHOUT_ROW_SQL, [T]);
    return rows.reduce((n, r) => n + Number(r.n), 0);
}

/** Map product_id → the admin tenant's signed on-hand. */
async function adminOnHand(adminDb, productIds) {
    const [rows] = await pool.query(ADMIN_ON_HAND_SQL, [[adminDb], productIds]);
    return new Map(rows.map((r) => [Number(r.product_id), Number(r.q)]));
}

// ---------------------------------------------------------------- assembly helpers

const nameOf = (r) => String(r.product_name ?? "");

// Ties in every list: product name (case- and accent-insensitive), then tenant, then
// product id. Aggregated rows have no database_id and compare equal on it.
const byName = (a, b) =>
    nameOf(a).localeCompare(nameOf(b), "en", { sensitivity: "base" }) ||
    (a.database_id ?? 0) - (b.database_id ?? 0) ||
    a.product_id - b.product_id;

/** Days of stock left at the window's sales rate (1 decimal); 0 when out, null when unsold. */
const daysCover = (onHand, sold, moverDays) => {
    if (!(sold > 0)) return null;
    return onHand <= 0 ? 0 : M.oneDecimal(onHand * moverDays, sold);
};

const stockTag = (onHand, cover) => {
    if (onHand <= 0) return "danger";
    if (cover !== null && cover < 7) return "warning";
    return "success";
};

const valueCells = (val) => ({
    value_cost: toMoney(val.cost),
    value_retail: toMoney(val.retail),
    value_wholesale: toMoney(val.wholesale),
    value_grand: toMoney(val.grand),
});

const zeroValue = () => ({ cost: 0, retail: 0, wholesale: 0, grand: 0 });
const addValue = (into, val) => {
    into.cost += val.cost;
    into.retail += val.retail;
    into.wholesale += val.wholesale;
    into.grand += val.grand;
};

/** Running sums of a set of base rows (cents and counts). */
function aggregate(rows) {
    const agg = {
        value: zeroValue(),
        units: 0,
        skuRows: 0,
        products: new Set(),
        low: 0,
        out: 0,
        dead: 0,
        dead_c: 0,
        deadRetail_c: 0,
        negative: 0,
    };
    for (const r of rows) {
        addValue(agg.value, r.val);
        agg.units += r.qty;
        if (r.on_hand > 0) {
            agg.skuRows += 1;
            agg.products.add(r.product_id);
        }
        if (r.on_hand < 0) agg.negative += 1;
        if (r.listLow) agg.low += 1;
        if (r.listOut) agg.out += 1;
        if (r.dead) {
            agg.dead += 1;
            agg.dead_c += r.val.cost;
            agg.deadRetail_c += r.val.retail;
        }
    }
    return agg;
}

const pendingSum = (orders) =>
    orders.reduce(
        (acc, o) => ({ units: acc.units + o.units, value_c: acc.value_c + o.value_c }),
        { units: 0, value_c: 0 },
    );

/**
 * InvTotals of an aggregate (contract §3.2). skus_in_stock counts rows for one tenant
 * and distinct products for a scope total. dead_share_pct is at cost, or at retail for
 * a restricted viewer.
 */
function totalsOf(agg, pendingIn, pendingOut, { distinctSkus, restricted }) {
    const v = agg.value;
    const per = (fn) => Object.fromEntries(BASES.map((b) => [b, fn(b)]));
    return {
        stock_cost: toMoney(v.cost),
        sale_value: per((b) => toMoney(v[b])),
        potential_margin: per((b) => toMoney(v[b] - v.cost)),
        potential_margin_pct: per((b) => pct(v[b] - v.cost, v[b])),
        units_on_hand: agg.units,
        skus_in_stock: distinctSkus ? agg.products.size : agg.skuRows,
        low_count: agg.low,
        out_count: agg.out,
        dead_count: agg.dead,
        dead_value_cost: toMoney(agg.dead_c),
        dead_value_retail: toMoney(agg.deadRetail_c),
        dead_share_pct: restricted
            ? pct(agg.deadRetail_c, v.retail)
            : pct(agg.dead_c, v.cost),
        pending_in_cost: toMoney(pendingIn.value_c),
        pending_in_units: pendingIn.units,
        pending_out_cost: toMoney(pendingOut.value_c),
        pending_out_units: pendingOut.units,
        negative_rows: agg.negative,
    };
}

/** The filtered lines added up per order; an order with no matching line is dropped. */
function ordersOf(lines) {
    const byId = new Map();
    for (const l of lines) {
        let o = byId.get(l.order_id);
        if (!o) {
            o = {
                order_id: l.order_id,
                invoice_number: l.invoice_number,
                order_datetime: l.order_datetime,
                receiver_id: l.receiver_id,
                sender_id: l.sender_id,
                units: 0,
                value_c: 0,
                legacy_lines: 0,
            };
            byId.set(l.order_id, o);
        }
        o.units += l.units;
        o.value_c += l.value_c;
        if (l.legacy) o.legacy_lines += 1;
    }
    return [...byId.values()];
}

// ---------------------------------------------------------------- the report

/**
 * Build the Inventory payload and its notes.
 *
 * @param {object} args
 * @param {{ key: string, mode: 'combined'|'single', database_ids: number[] }} args.scope
 * @param {ReturnType<typeof parseInventoryBody>} args.params
 * @param {{ isAdmin: boolean, databaseId: number }} args.reports  req.reports
 * @param {Array} args.directory  scope.loadDirectory() rows
 * @param {boolean} args.restricted  view_cost off and not the admin
 * @returns {Promise<{ payload: object, notes: Array<{code: string, count: number, database_id?: number}> }>}
 */
async function getInventory({
    scope,
    params,
    reports,
    directory,
    restricted,
    now = nowBeirut(),
}) {
    const T = scope.database_ids;
    const combined = scope.mode === "combined";
    const win = relativeWindows(params.deadDays, params.moverDays, now);
    const filter = M.filterSql(params);
    // Rankings and the share percentages: cost, or retail when cost is hidden (D8)
    const rank = restricted ? "retail" : "cost";
    // Whose prices a user shop's unpriced rows take (S5): the admin tenant, which is the
    // admin caller's own (A11), else the tenant with an admin login
    const priceAdminDb = reports.isAdmin
        ? reports.databaseId
        : (directory.find((d) => d.has_admin)?.database_id ?? null);

    // Groups 1 and 2, never more than 4 queries at a time
    const [base, lastSale, receipts, sales, lines, dupPairs, withoutRow] = await M.runLimited([
        () => M.liveBase(T, filter, priceAdminDb),
        () => M.lastSales(T),
        () => M.receipts(T),
        () => M.windowSales(T, win.mover_lo, win.mover_hi),
        () => M.pendingLines(T, filter),
        () => duplicatePairs(T),
        () => stockWithoutRow(T),
    ]);

    // ---- base rows with their side data and list flags
    const rows = base.map((r) => {
        const k = M.key(r.database_id, r.product_id);
        const qty = Math.max(r.on_hand, 0);
        const sold = sales.get(k);
        const rec = receipts.get(k);
        const last_sale = lastSale.get(k) ?? null;
        const first_receipt = rec ? rec.first_receipt : null;
        const sold_window = sold ? sold.units_sold : 0;
        const orders_window = sold ? sold.orders : 0;

        const low = r.threshold !== null && r.on_hand <= r.threshold;
        const out = r.on_hand <= 0 && (sold_window > 0 || r.threshold !== null);
        const visible = params.includeHidden || !r.hidden_on_sell;
        return {
            ...r,
            qty,
            val: {
                cost: qty * r.unit_cost_c,
                retail: qty * r.retail_c,
                wholesale: qty * r.wholesale_c,
                grand: qty * r.grand_c,
            },
            sold_window,
            orders_window,
            sales_c: sold ? sold.sales_c : 0,
            last_sale,
            last_receipt: rec ? rec.last_receipt : null,
            low,
            out,
            listLow: low && visible,
            listOut: out && visible,
            // The receipt is a ledger stamp (UTC on production, 2–3 h behind Beirut), so
            // it is compared by calendar day only (Phase 0 deviation): received before
            // the cutoff's day. The last sale is Beirut time, compared to the second.
            dead:
                r.on_hand > 0 &&
                (last_sale === null || last_sale < win.dead_cutoff) &&
                (first_receipt === null || first_receipt.slice(0, 10) < win.dead_cutoff.slice(0, 10)),
        };
    });
    const shown = rows.filter((r) => r.in_filter);
    const orders = ordersOf(lines.filter((l) => l.in_filter));

    // ---- KPIs: per tenant, then the scope total
    const inT = new Set(T);
    const byTenantAgg = new Map(T.map((t) => [t, aggregate(shown.filter((r) => r.database_id === t))]));
    const totalAgg = aggregate(shown);

    const by_tenant = {};
    for (const t of T) {
        by_tenant[String(t)] = totalsOf(
            byTenantAgg.get(t),
            pendingSum(orders.filter((o) => o.receiver_id === t)),
            pendingSum(orders.filter((o) => o.sender_id === t)),
            { restricted, distinctSkus: false },
        );
    }
    const total = totalsOf(
        totalAgg,
        pendingSum(orders.filter((o) => inT.has(o.receiver_id))),
        pendingSum(orders.filter((o) => inT.has(o.sender_id))),
        { restricted, distinctSkus: true },
    );

    // ---- Low stock and Out of stock (the hidden rule only applies here, A9)
    const lowAll = shown.filter((r) => r.listLow);
    lowAll.sort((a, b) => a.on_hand - a.threshold - (b.on_hand - b.threshold) || byName(a, b));
    const outAll = shown.filter((r) => r.listOut);
    outAll.sort((a, b) => a.on_hand - b.on_hand || byName(a, b));
    const lowShown = lowAll.slice(0, LIST_ROWS);

    // Group 3, as applicable: the admin's restock hint and the money behind exposure,
    // with the user shops' untaken profit share (Phase 7.1: M31 and M32 through the
    // current month; no pending entries)
    const adminDb = reports.isAdmin ? reports.databaseId : null;
    const lowIds = [...new Set(lowShown.map((r) => r.product_id))];
    const queryHint = adminDb !== null && !combined && T[0] !== adminDb && lowIds.length > 0;
    let idsPromise = null;
    const ids = () => (idsPromise ??= getAccountIds());
    const shareUsers = combined && !restricted ? T.filter((t) => t !== adminDb) : [];
    const lastMonth = monthOf(now);
    const group3 = await M.runLimited([
        queryHint ? () => adminOnHand(adminDb, lowIds) : () => null,
        combined ? async () => M.cashWhish(T, await ids()) : () => null,
        combined ? () => M.receivables(T) : () => null,
        ...P.partnerThunks(shareUsers, { lastMonth, ids }),
    ]);
    const [hintRows, cash, recv] = group3;
    const dirShare = new Map(directory.map((d) => [d.database_id, d.profit_share_pct]));
    const partner = shareUsers.length
        ? P.partnerFold(group3.slice(3), shareUsers, (t) => bp(asMoney(dirShare.get(t)) ?? "0.00"), {
              now,
              lastMonth,
          })
        : { byTenant: new Map(), notSetUp: false };

    // The admin's own on-hand, shown on rows of another tenant: in Combined straight
    // from the base rows, else from the query above
    let adminHint = null;
    if (adminDb !== null && combined) {
        adminHint = new Map(
            rows.filter((r) => r.database_id === adminDb).map((r) => [r.product_id, r.on_hand]),
        );
    } else if (adminDb !== null && T[0] !== adminDb) {
        adminHint = hintRows || new Map();
    }

    const lowRow = (r, withHint) => {
        const row = {
            database_id: r.database_id,
            product_id: r.product_id,
            product_name: r.product_name,
            sku: r.sku,
            category_name: r.category_name,
            on_hand: r.on_hand,
            threshold: r.threshold,
            sold_window: r.sold_window,
            days_cover: daysCover(r.on_hand, r.sold_window, params.moverDays),
            hidden_on_sell: r.hidden_on_sell,
        };
        if (withHint && adminHint && r.database_id !== adminDb) {
            row.admin_on_hand = adminHint.get(r.product_id) ?? 0;
        }
        return row;
    };
    const hiddenDropped = (flagName) =>
        params.includeHidden ? 0 : shown.filter((r) => r[flagName] && r.hidden_on_sell).length;

    const low_stock = {
        count: lowAll.length,
        hidden_count: hiddenDropped("low"),
        rows: lowShown.map((r) => lowRow(r, true)),
    };
    const out_of_stock = {
        count: outAll.length,
        hidden_count: hiddenDropped("out"),
        rows: outAll.slice(0, LIST_ROWS).map((r) => lowRow(r, false)),
    };

    // ---- Dead stock: in stock, no sale since the cutoff, not a recent arrival
    const deadAll = shown.filter((r) => r.dead);
    deadAll.sort((a, b) => b.val[rank] - a.val[rank] || byName(a, b));
    const dead_stock = {
        count: deadAll.length,
        rows: deadAll.slice(0, LIST_ROWS).map((r) => ({
            database_id: r.database_id,
            product_id: r.product_id,
            product_name: r.product_name,
            sku: r.sku,
            category_name: r.category_name,
            on_hand: r.on_hand,
            ...valueCells(r.val),
            last_sale: r.last_sale,
            days_since_sale: r.last_sale ? daysBetween(r.last_sale.slice(0, 10), win.today) : null,
            last_receipt: r.last_receipt,
            share_of_shop_pct: pct(r.val[rank], byTenantAgg.get(r.database_id).value[rank]),
        })),
    };

    // ---- Fast movers and Highest value: one row per product (Combined adds them up)
    const byProduct = new Map();
    for (const r of shown) {
        if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
        byProduct.get(r.product_id).push(r);
    }
    const productHead = (r) => ({
        product_id: r.product_id,
        product_name: r.product_name,
        sku: r.sku,
        category_name: r.category_name,
    });

    let fast;
    if (combined) {
        fast = [];
        for (const group of byProduct.values()) {
            const units = group.reduce((n, r) => n + r.sold_window, 0);
            if (!(units > 0)) continue;
            const onHand = group.reduce((n, r) => n + r.qty, 0);
            const cover = daysCover(onHand, units, params.moverDays);
            const by_shop = group
                .filter((r) => r.sold_window > 0 || r.on_hand > 0)
                .map((r) => {
                    const c = daysCover(r.on_hand, r.sold_window, params.moverDays);
                    return {
                        database_id: r.database_id,
                        units_sold: r.sold_window,
                        orders: r.orders_window,
                        on_hand: r.on_hand,
                        days_cover: c,
                        tag: stockTag(r.on_hand, c),
                    };
                })
                .sort((a, b) => b.units_sold - a.units_sold || a.database_id - b.database_id);
            fast.push({
                ...productHead(group[0]),
                units_sold: units,
                // an invoice belongs to one shop, so the shops' counts add up to the
                // distinct invoices (S8)
                orders: group.reduce((n, r) => n + r.orders_window, 0),
                sales_c: group.reduce((n, r) => n + r.sales_c, 0),
                on_hand: onHand,
                days_cover: cover,
                tag: stockTag(onHand, cover),
                by_shop,
            });
        }
    } else {
        fast = shown
            .filter((r) => r.sold_window > 0)
            .map((r) => {
                const cover = daysCover(r.on_hand, r.sold_window, params.moverDays);
                return {
                    ...productHead(r),
                    database_id: r.database_id, // tie-break only, dropped below
                    units_sold: r.sold_window,
                    orders: r.orders_window,
                    sales_c: r.sales_c,
                    on_hand: r.on_hand,
                    days_cover: cover,
                    tag: stockTag(r.on_hand, cover),
                };
            });
    }
    fast.sort((a, b) => b.units_sold - a.units_sold || b.sales_c - a.sales_c || byName(a, b));
    const fast_movers = {
        rows: fast.slice(0, TOP_ROWS).map((f) => {
            const row = {
                product_id: f.product_id,
                product_name: f.product_name,
                sku: f.sku,
                category_name: f.category_name,
                units_sold: f.units_sold,
                orders: f.orders,
                sales_value: toMoney(f.sales_c),
                on_hand: f.on_hand,
                days_cover: f.days_cover,
                tag: f.tag,
            };
            if (f.by_shop) row.by_shop = f.by_shop;
            return row;
        }),
    };

    let high;
    if (combined) {
        high = [];
        for (const group of byProduct.values()) {
            const stocked = group.filter((r) => r.on_hand > 0);
            if (!stocked.length) continue;
            const val = zeroValue();
            stocked.forEach((r) => addValue(val, r.val));
            const onHand = stocked.reduce((n, r) => n + r.qty, 0);
            high.push({
                ...productHead(stocked[0]),
                on_hand: onHand,
                avg_c: roundHalfAway(val.cost / onHand),
                val,
                by_shop: [...stocked]
                    .sort((a, b) => b.val[rank] - a.val[rank] || a.database_id - b.database_id)
                    .map((r) => ({
                        database_id: r.database_id,
                        on_hand: r.qty,
                        unit_cost: toMoney(r.unit_cost_c),
                        ...valueCells(r.val),
                    })),
            });
        }
    } else {
        high = shown
            .filter((r) => r.on_hand > 0)
            .map((r) => ({
                ...productHead(r),
                database_id: r.database_id, // tie-break only
                on_hand: r.qty,
                avg_c: r.unit_cost_c,
                val: r.val,
            }));
    }
    high.sort((a, b) => b.val[rank] - a.val[rank] || byName(a, b));
    const highest_value = {
        rows: high.slice(0, TOP_ROWS).map((h) => {
            const row = {
                ...productHead(h),
                on_hand: h.on_hand,
                avg_cost: toMoney(h.avg_c),
                ...valueCells(h.val),
                pct_of_total: pct(h.val[rank], totalAgg.value[rank]),
            };
            if (h.by_shop) row.by_shop = h.by_shop;
            return row;
        }),
    };

    // ---- In transit (deliveries awaiting approval, M23 per order)
    const dirById = new Map(directory.map((d) => [d.database_id, d]));
    const shopName = (id) => {
        const name = String(dirById.get(id)?.database_name ?? "").trim();
        return name || `Shop ${id}`;
    };
    const transit = orders
        .map((o) => {
            const receives = inT.has(o.receiver_id);
            const sends = inT.has(o.sender_id);
            return {
                order_id: o.order_id,
                invoice_number: o.invoice_number,
                dispatched_at: o.order_datetime,
                sender_id: o.sender_id,
                sender_name: shopName(o.sender_id),
                receiver_id: o.receiver_id,
                receiver_name: shopName(o.receiver_id),
                direction: receives && sends ? "internal" : receives ? "in" : "out",
                units: o.units,
                value_cost: toMoney(o.value_c),
                age_days: daysBetween(String(o.order_datetime).slice(0, 10), win.today),
                legacy_lines: o.legacy_lines,
            };
        })
        .sort((a, b) => b.age_days - a.age_days || a.order_id - b.order_id);
    const in_transit = { count: transit.length, rows: transit.slice(0, LIST_ROWS) };

    // ---- Value by category (+ "Other" beyond the first 15 bars)
    const byCategory = new Map();
    for (const r of shown) {
        if (r.qty <= 0) continue;
        const k = r.category_id === null ? "none" : r.category_id;
        let c = byCategory.get(k);
        if (!c) {
            c = { category_id: r.category_id, category_name: r.category_name, units: 0, val: zeroValue() };
            byCategory.set(k, c);
        }
        c.units += r.qty;
        addValue(c.val, r.val);
    }
    const catName = (c) => (c.category_name === null ? null : String(c.category_name));
    const categories = [...byCategory.values()].sort(
        (a, b) =>
            b.val[rank] - a.val[rank] ||
            (catName(a) === null) - (catName(b) === null) ||
            String(catName(a) ?? "").localeCompare(String(catName(b) ?? ""), "en", { sensitivity: "base" }) ||
            (a.category_id ?? Infinity) - (b.category_id ?? Infinity),
    );
    const catRow = (c) => ({
        category_id: c.category_id,
        category_name: c.category_name,
        units: c.units,
        ...valueCells(c.val),
    });
    const by_category = categories.map(catRow);
    let by_category_other = null;
    if (categories.length > CATEGORY_BARS) {
        const rest = categories.slice(CATEGORY_BARS);
        const val = zeroValue();
        rest.forEach((c) => addValue(val, c.val));
        by_category_other = {
            category_id: null,
            category_name: null,
            units: rest.reduce((n, c) => n + c.units, 0),
            ...valueCells(val),
            categories: rest.length,
        };
    }

    // ---- Stock by shop (Combined only, so admin only): the KPIs per tenant, plus the
    // assets-cap exposure of each user's shop over ALL its stock and pending incoming
    // lines, whatever the filter (D-P2-1)
    let by_shop;
    if (combined) {
        const allStock = new Map();
        for (const r of rows) allStock.set(r.database_id, (allStock.get(r.database_id) || 0) + r.val.cost);
        const allPendingIn = new Map();
        for (const o of ordersOf(lines)) {
            allPendingIn.set(o.receiver_id, (allPendingIn.get(o.receiver_id) || 0) + o.value_c);
        }

        const shopRow = (t) => {
            const agg = byTenantAgg.get(t);
            const kpi = by_tenant[String(t)];
            const cap = dirById.get(t)?.assets_cap_usd ?? null;
            // The admin's own shop has no cap usage
            let exp;
            if (t === adminDb) {
                exp = {
                    exposure_used: null,
                    exposure_pct: null,
                    exposure_status: null,
                    holdings_cost: null,
                    untaken_profit_share: null,
                };
            } else {
                const segments = {
                    cash_c: cash.get(t)?.cash_c ?? 0,
                    whish_c: cash.get(t)?.whish_c ?? 0,
                    receivables_c: recv.get(t)?.receivables_c ?? 0,
                    stock_c: allStock.get(t) ?? 0,
                    pending_in_c: allPendingIn.get(t) ?? 0,
                    untaken_c: partner.byTenant.get(t)?.untaken_c ?? 0,
                    cap,
                };
                exp = {
                    ...M.exposure(segments),
                    holdings_cost: toMoney(M.holdings(segments)),
                    untaken_profit_share: toMoney(segments.untaken_c),
                };
            }
            return {
                database_id: t,
                units: agg.units,
                skus: agg.skuRows,
                ...valueCells(agg.value),
                dead_value_cost: kpi.dead_value_cost,
                dead_value_retail: kpi.dead_value_retail,
                low_count: agg.low,
                out_count: agg.out,
                pending_in_cost: kpi.pending_in_cost,
                pending_in_units: kpi.pending_in_units,
                pending_out_cost: kpi.pending_out_cost,
                pending_out_units: kpi.pending_out_units,
                assets_cap_usd: asMoney(cap),
                ...exp,
            };
        };
        by_shop = [...T]
            .sort(
                (a, b) =>
                    byTenantAgg.get(b).value[rank] - byTenantAgg.get(a).value[rank] || a - b,
            )
            .map(shopRow);
    }

    // ---- notes (plan §9): scope-wide counts, no database_id, except the per-shop
    // admin-price fallback
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
    note("NEGATIVE_STOCK", total.negative_rows);
    const inStock = shown.filter((r) => r.on_hand > 0);
    if (!restricted) {
        note("ZERO_COST_STOCK", inStock.filter((r) => r.unit_cost_c === 0).length);
    }
    // S5: rows in stock valued at the admin's prices, one note per user shop
    for (const t of T) {
        note(
            "ADMIN_PRICE_FALLBACK",
            inStock.filter((r) => r.database_id === t && r.admin_priced).length,
            { database_id: t },
        );
    }
    note(
        "ZERO_PRICE_STOCK",
        inStock.filter((r) => r.retail_c === 0 || r.wholesale_c === 0 || r.grand_c === 0).length,
    );
    note("DUPLICATE_INVENTORY_ROWS", dupPairs);
    note("STOCK_WITHOUT_INVENTORY_ROW", withoutRow);
    if (!restricted) {
        note("LEGACY_DELIVERY_SNAPSHOT", transit.filter((o) => o.legacy_lines > 0).length);
        note("NO_COST_HISTORY", 1);
        note("AVG_ROUNDING", 1);
    }
    note("LEDGER_CLOCK", 1);
    note("RECEIPT_IS_APPROVAL", total.dead_count);
    if (reports.isAdmin) note("DISPOSE_EDIT_DEFECT", 1);
    // Before §7.7 (PA15): no share counts as taken, so the Cap used column reads the
    // earned share as untaken; the admin is told why
    if (
        reports.isAdmin &&
        shareUsers.length > 0 &&
        (partner.notSetUp || (await ids()).a108 === null)
    ) {
        note("PARTNER_NOT_SET_UP", 1);
    }

    const payload = {
        params: {
            dead_days: params.deadDays,
            mover_days: params.moverDays,
            dead_cutoff: win.dead_cutoff,
            mover_lo: win.mover_lo,
            mover_hi: win.mover_hi,
            category_id: params.categoryId,
            brand_id: params.brandId,
            search: params.search,
            include_hidden: params.includeHidden,
            filtered:
                params.categoryId !== null || params.brandId !== null || params.pattern !== null,
        },
        total,
        by_tenant,
        low_stock,
        out_of_stock,
        dead_stock,
        fast_movers,
        highest_value,
    };
    if (combined) payload.by_shop = by_shop;
    payload.in_transit = in_transit;
    payload.by_category = by_category;
    payload.by_category_other = by_category_other;

    return { payload, notes };
}

module.exports = { parseInventoryBody, getInventory };
