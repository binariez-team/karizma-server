const pool = require("../../config/database");

// Chart account ids the reports filter on, always looked up by account NUMBER (plan
// §3.4). Ids differ between databases; hard-coding them is how the old supplier
// payments report went wrong (ReportModel, id 7). Cached for 10 minutes.
//
// 108 Partner Drawings (Phase 7.1, §7.7) is OPTIONAL: a108 is null while the chart has
// no such row, so every page keeps working before the migration runs (PA15). A result
// without it is never cached: the next request reads the chart again. A cached null
// would hide approved shares from the taken share (M32) for up to 10 minutes while the
// cash (M20) already shows them.
//
// The accounts of the admin's cash corrections with reasons (§7.8, 2026-10-22) are
// OPTIONAL by the same rule: 1081 Owner Drawings, 658 Unknown Cash Loss, 758 Unknown
// Cash Gain and 533 Cash Outside the Till. The reports read only a533 (the Balance
// sheet's "Outside the till" line, M36); the P&L reads the CLS / CGN vouchers by number
// (M35), and the correction writer reads every id on its own transaction.

const NUMBERS = {
    a101: "101", // capital (debt write-offs)
    a401: "401",
    a413: "413", // customer payments and refunds
    a4011: "4011",
    a4111: "4111", // customer invoices and returns
    a531: "531", // cash
    a532: "532", // whish
    a6011: "6011",
    a6112: "6112", // expenses
    a7011: "7011", // sales
};
// Read in the same statement, but null (never an error) while missing
const OPTIONAL = {
    a108: "108", // partner drawings: shares taken (Phase 7.1)
    a1081: "1081", // owner drawings: the admin's own (§7.8; never 108)
    a658: "658", // unknown cash loss (§7.8, in M10)
    a758: "758", // unknown cash gain (§7.8, in M10)
    a533: "533", // cash outside the till: safe, bank, owner's hands (§7.8)
};
const TTL_MS = 10 * 60 * 1000;

let cache = null; // { ids, at }

/**
 * @returns {Promise<{a101: number, a401: number, a413: number, a4011: number,
 *   a4111: number, a531: number, a532: number, a6011: number, a6112: number,
 *   a7011: number, a108: number|null, a1081: number|null, a658: number|null,
 *   a758: number|null, a533: number|null}>}
 */
async function getAccountIds() {
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS) return cache.ids;

    const [rows] = await pool.query(
        `/* rk:accounts.ids */ SELECT id, account_number FROM chart_of_accounts
        WHERE account_number IN (?) ORDER BY id`,
        [[...Object.values(NUMBERS), ...Object.values(OPTIONAL)]],
    );
    // Lowest id wins should a number ever appear twice
    const byNumber = new Map();
    for (const row of rows) {
        const number = String(row.account_number);
        if (!byNumber.has(number)) byNumber.set(number, Number(row.id));
    }

    const ids = {};
    for (const [key, number] of Object.entries(NUMBERS)) {
        // A missing account would silently zero every figure built on it
        if (!byNumber.has(number)) {
            throw new Error(`Chart account ${number} not found`);
        }
        ids[key] = byNumber.get(number);
    }
    for (const [key, number] of Object.entries(OPTIONAL)) {
        ids[key] = byNumber.has(number) ? byNumber.get(number) : null;
    }
    // Cached only once every optional account exists (PA15)
    if (Object.values(OPTIONAL).every((number) => byNumber.has(number))) {
        cache = { ids, at: now };
    }
    return ids;
}

module.exports = { getAccountIds };
