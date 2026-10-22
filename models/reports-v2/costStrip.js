// view_cost stripping (D8, plan §3.5).
//
// A viewer who is not the admin and whose live users.view_cost is off must not receive
// cost, COGS, profit, margin or any cost-based stock value. The controller runs strip()
// on the page payload only, just before sending; `meta`, `tenants` and `notes` are never
// passed through it (tenants carry `share_pct`, deliberately not named profit_share_pct).
//
// A key is removed, in objects and in arrays of objects at any depth, when it matches
// COST_KEY_RE or is in STRIP_SET. Naming rule: every cost-derived response field must be
// named so this catches it, and nothing else may use those name parts.

const COST_KEY_RE = /(^|_)(cost|costs|cogs|profit|margin|gp)(_|$)/;

const STRIP_SET = new Set([
    "disposals",
    "user_share",
    "admin_share",
    "admin_keeps",
    "users_share",
    "settlement",
    "settlement_due",
    "still_owed",
    "owed_after",
    "dues_total",
    "exposure_used",
    "exposure_pct",
    "exposure_headroom",
    "exposure_status",
    "net_position",
    "total_assets",
    "purchases",
    "waterfall",
]);

const isCostKey = (key) => COST_KEY_RE.test(key) || STRIP_SET.has(key);

const isPlainObject = (value) => {
    if (value === null || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};

/** A deep copy of `payload` without the cost keys; the input is not modified. */
function strip(payload) {
    if (Array.isArray(payload)) return payload.map(strip);
    if (!isPlainObject(payload)) return payload;

    const out = {};
    for (const [key, value] of Object.entries(payload)) {
        if (isCostKey(key)) continue;
        out[key] = strip(value);
    }
    return out;
}

module.exports = { COST_KEY_RE, STRIP_SET, isCostKey, strip };
