const { badRequest } = require("./errors");

// Body parsing of the reports endpoints (plan §3.7). Every field is read explicitly and
// unknown keys are ignored. Nothing from the body is ever bound as an object: mysql2
// expands `?` with a plain object into `key` = value SQL, and the pool runs with
// multipleStatements. Each failure throws 400 BAD_REQUEST naming the field.

const absent = (v) => v === undefined || v === null || v === "";

/**
 * A whole number: a JS integer or a plain digit string ("-" allowed when min < 0).
 * Absent → `def` when given, else refused.
 */
function int(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER, def } = {}) {
    if (absent(value)) {
        if (def !== undefined) return def;
        throw badRequest(field, `${field} is required.`);
    }
    const n =
        typeof value === "number" ||
        (typeof value === "string" && /^-?\d+$/.test(value))
            ? Number(value)
            : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
        throw badRequest(field, `${field} is not valid.`);
    }
    return n;
}

/** A whole number from a fixed list (e.g. the day chips 30/60/90/180). Absent → `def`. */
function intIn(value, field, allowed, { def } = {}) {
    const n = int(value, field, { min: Number.MIN_SAFE_INTEGER, def });
    if (!allowed.includes(n)) throw badRequest(field, `${field} is not valid.`);
    return n;
}

/** Strictly true / false / 1 / 0. Absent → `def` (false unless given). */
function bool(value, field, { def = false } = {}) {
    if (value === undefined || value === null) return def;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    throw badRequest(field, `${field} is not valid.`);
}

/** One of `allowed` (an array or a Set of strings). Absent → `def` when given. */
function enumOf(value, field, allowed, { def } = {}) {
    if (absent(value) && def !== undefined) return def;
    const set = allowed instanceof Set ? allowed : new Set(allowed);
    if (typeof value !== "string" || !set.has(value)) {
        throw badRequest(field, `${field} is not valid.`);
    }
    return value;
}

/**
 * A search term (at most 100 chars) as a LIKE "contains" pattern, or null when empty.
 * \ % _ are escaped so they match literally (same as UserHistoryModel.invoiceContains).
 */
function search(value, field = "search") {
    if (absent(value)) return null;
    if (typeof value !== "string" || value.length > 100) {
        throw badRequest(field, "Search is too long or not valid.");
    }
    const term = value.trim();
    if (!term) return null;
    return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Page size 1..max (200; the ledger passes 500). */
const limit = (value, { max = 200, def = 50 } = {}) =>
    int(value, "limit", { min: 1, max, def });

/** Row offset 0..100000. */
const offset = (value) => int(value, "offset", { min: 0, max: 100000, def: 0 });

module.exports = { int, intIn, bool, enumOf, search, limit, offset };
