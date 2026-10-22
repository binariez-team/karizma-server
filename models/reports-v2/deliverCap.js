const pool = require("../../config/database");
const { toCents, toMoney, asMoney, bp } = require("./money");
const { nowBeirut, monthOf } = require("./dates");
const { getAccountIds } = require("./accounts");
const { loadDirectory } = require("./scope");
const { badRequest } = require("./errors");
const M = require("./metrics");
const P = require("./partner");

// Deliver-screen cap warning (plan §8 Phase 7 item 3, Phase 7.1 PA14): the receiver's
// assets-cap use (M30, net of his untaken profit share) now, and after the delivery the
// admin is preparing. Non-blocking: nothing is refused because of it. The admin sender
// only (owner answer 2026-10-22): users never see another shop's cap.
//
// - before = metrics.exposureDetail of the receiver now, from the same metrics as the
//   Balance sheet and Inventory (cash and whish, receivables, stock at cost, deliveries
//   awaiting approval into the shop, less the untaken share through the current month);
// - after = the same segments plus the draft lines valued at the SENDER's live cost (M17:
//   the latest live inventory row's average, else its unit cost, else 0) — the cost the
//   delivery is snapshotted at when it is sent, so the pending figure it then adds is the
//   same. Editing a pending delivery: the order being edited (order_id, the caller's own,
//   to this receiver) is taken out of "after", as the edit replaces its lines.
// - Every figure is computed here in cents; the client only displays them (§3.8).

const MAX_LINES = 1000;

// M17 of the sender's latest live row per product; deleted products are out (S7: a
// delivery of one is not stock anywhere)
const DRAFT_COST_SQL = `/* rk:deliver_cap.draft_cost */
SELECT i.product_id_fk AS product_id, COALESCE(NULLIF(i.avg_cost_usd,0), i.unit_cost_usd, 0) AS unit_cost
FROM (SELECT MAX(record_id) AS rid FROM inventory
      WHERE is_deleted = 0 AND database_id IN (?) AND product_id_fk IN (?) GROUP BY product_id_fk) ix
JOIN inventory i ON i.record_id = ix.rid
JOIN products p ON p.product_id = i.product_id_fk AND p.is_deleted = 0`;

// A positive whole number (an id or a quantity), as DeliverModel.toId: a number or a
// digit string; anything else (an object would expand into SQL) is refused
const toPositive = (value) => {
    const n =
        typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))
            ? Number(value)
            : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * { database_id, items: [{ product_id, quantity }], order_id? }. Unknown keys (prices,
 * names) are ignored; 400 BAD_REQUEST naming the field otherwise.
 *
 * @returns {{ receiver: number, lines: Array<{product_id: number, quantity: number}>,
 *   orderId: number|null }}
 */
function parseCapCheckBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const receiver = toPositive(b.database_id);
    if (!receiver) throw badRequest("database_id", "Pick a recipient.");
    if (!Array.isArray(b.items) || b.items.length > MAX_LINES) {
        throw badRequest("items", "items is not valid.");
    }
    const lines = b.items.map((item) => {
        const product_id = item && typeof item === "object" ? toPositive(item.product_id) : null;
        const quantity = item && typeof item === "object" ? toPositive(item.quantity) : null;
        if (!product_id || !quantity) throw badRequest("items", "items is not valid.");
        return { product_id, quantity };
    });
    let orderId = null;
    if (b.order_id !== undefined && b.order_id !== null && b.order_id !== "") {
        orderId = toPositive(b.order_id);
        if (!orderId) throw badRequest("order_id", "order_id is not valid.");
    }
    return { receiver, lines, orderId };
}

/** Map product_id → the sender's unit cost in cents (M17). */
async function draftCosts(senderDb, productIds) {
    if (!productIds.length) return new Map();
    const [rows] = await pool.query(DRAFT_COST_SQL, [[senderDb], productIds]);
    return new Map(rows.map((r) => [Number(r.product_id), toCents(r.unit_cost)]));
}

/**
 * The receiver's cap use before and after the draft. The receiver must already have
 * passed the deliver recipient check (DeliverModel.assertRecipient), so it is a user
 * shop.
 *
 * @param {{ receiver: number, lines: Array, orderId: number|null }} params
 * @param {number} senderDb  the admin caller's tenant
 * @param {moment.Moment} [now]
 */
async function getCapCheck({ receiver, lines, orderId }, senderDb, now = nowBeirut()) {
    const T = [receiver];
    const filter = M.filterSql({});
    let idsPromise = null;
    const ids = () => (idsPromise ??= getAccountIds());
    const lastMonth = monthOf(now);
    const productIds = [...new Set(lines.map((l) => l.product_id))];

    const results = await M.runLimited([
        () => loadDirectory(),
        () => M.liveBase(T, filter, null),
        () => M.pendingLines(T, filter),
        async () => M.cashWhish(T, await ids()),
        () => M.receivables(T),
        () => draftCosts(senderDb, productIds),
        ...P.partnerThunks(T, { lastMonth, ids }),
    ]);
    const [directory, base, pending, cash, recv, costs] = results;
    const dir = directory.find((d) => d.database_id === receiver);
    const cap = dir?.assets_cap_usd ?? null;
    const shareBp = bp(asMoney(dir?.profit_share_pct ?? null) ?? "0.00");
    const partner = P.partnerFold(results.slice(6), T, () => shareBp, { now, lastMonth });
    const untaken_c = partner.byTenant.get(receiver)?.untaken_c ?? 0;

    // M18 over the whole shop: max(on_hand, 0) × M17
    let stock_c = 0;
    for (const r of base) {
        if (r.database_id === receiver) stock_c += Math.max(r.on_hand, 0) * r.unit_cost_c;
    }
    // M24: deliveries awaiting approval into the shop; the order being edited is the
    // caller's own pending delivery to this receiver
    let pending_in_c = 0;
    let editing_c = 0;
    for (const l of pending) {
        if (l.receiver_id !== receiver) continue;
        pending_in_c += l.value_c;
        if (orderId !== null && l.order_id === orderId && l.sender_id === senderDb) {
            editing_c += l.value_c;
        }
    }
    let draft_c = 0;
    let draft_units = 0;
    for (const l of lines) {
        draft_c += l.quantity * (costs.get(l.product_id) ?? 0);
        draft_units += l.quantity;
    }

    const c = cash.get(receiver) || { cash_c: 0, whish_c: 0 };
    const segments = {
        cash_c: c.cash_c,
        whish_c: c.whish_c,
        receivables_c: recv.get(receiver)?.receivables_c ?? 0,
        stock_c,
        pending_in_c,
        untaken_c,
        cap,
    };
    return {
        database_id: receiver,
        assets_cap_usd: asMoney(cap),
        draft_cost: toMoney(draft_c),
        draft_units,
        replaced_cost: toMoney(editing_c),
        before: M.exposureDetail(segments),
        after: M.exposureDetail({ ...segments, pending_in_c: pending_in_c - editing_c + draft_c }),
    };
}

module.exports = { parseCapCheckBody, getCapCheck };
