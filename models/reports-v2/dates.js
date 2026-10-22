const moment = require("moment-timezone");
const { badRange } = require("./errors");

// Dates of the reports (plan §3.3).
//
// Stored datetimes are Beirut wall clock and the pool sets no time zone, so "now" is
// always moment.tz(TZ) — never bare moment() (write paths mutate moment.tz.setDefault,
// SellOrdersModel) and never MySQL NOW()/CURDATE().
//
// Ranges are inclusive 'YYYY-MM-DD' days, turned into half-open wall-clock bounds
// [from 00:00:00, to+1 00:00:00) for `col >= ? AND col < ?` (never DATE(col), never
// BETWEEN).
//
// Day arithmetic on those calendar strings is done on UTC moments: Beirut switches to
// summer time AT midnight, so the Beirut moment of the last Sunday of March starts at
// 01:00 and a diff across it comes out one day short. A calendar day has no time zone.

const TZ = "Asia/Beirut";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 1100;
// The days a report range may cover (D-P6-S5). Outside them a request is a 400, not a
// failed statement: an end day of 9999-12-31 would bind hi = '10000-01-01 00:00:00',
// which MySQL's DATETIME refuses (a generic 500).
const FIRST_DAY = "2000-01-01";
const LAST_DAY = "2099-12-31";
const inWindow = (value) => value >= FIRST_DAY && value <= LAST_DAY;

const nowBeirut = () => moment.tz(TZ);
const nowString = () => nowBeirut().format("YYYY-MM-DD HH:mm:ss");

// A strict 'YYYY-MM-DD' as a calendar-day moment, or null
const day = (value) => {
    if (typeof value !== "string" || !DAY_RE.test(value)) return null;
    const m = moment.tz(value, "YYYY-MM-DD", true, "UTC");
    return m.isValid() ? m : null;
};

const daysInclusive = (from, to) => day(to).diff(day(from), "days") + 1;

/** Half-open Beirut wall-clock bounds of the inclusive day range. */
const bounds = (from, to) => ({
    lo: `${from} 00:00:00`,
    hi: `${day(to).add(1, "day").format("YYYY-MM-DD")} 00:00:00`,
});

/**
 * Read { from, to } off a request body. Both are required inclusive days from 2000 to
 * 2099, from <= to, at most 1100 days apart. Throws 400 BAD_RANGE with the offending
 * field.
 *
 * @returns {{ from: string, to: string, lo: string, hi: string, days: number }}
 */
function parseRange(body) {
    const { from, to } = body || {};
    if (!day(from)) throw badRange("from", "Pick a valid start date.");
    if (!day(to)) throw badRange("to", "Pick a valid end date.");
    if (!inWindow(from)) throw badRange("from", "Pick a start date from 2000 to 2099.");
    if (!inWindow(to)) throw badRange("to", "Pick an end date from 2000 to 2099.");
    if (from > to) throw badRange("from", "The start date is after the end date.");

    const days = daysInclusive(from, to);
    if (days > MAX_RANGE_DAYS) {
        throw badRange("to", `Pick a range of at most ${MAX_RANGE_DAYS} days.`);
    }
    return { from, to, ...bounds(from, to), days };
}

/**
 * Bucket size of a trend (morexa's rule): up to 2 days by hour, up to 92 by day, else by
 * month. `sql` is the DATE_FORMAT pattern, `js` the moment format of the same keys for
 * zero-filling the buckets.
 */
function granularity(from, to) {
    const days = daysInclusive(from, to);
    if (days <= 2) return { unit: "hour", sql: "%Y-%m-%d %H:00", js: "YYYY-MM-DD HH:00" };
    if (days <= 92) return { unit: "day", sql: "%Y-%m-%d", js: "YYYY-MM-DD" };
    return { unit: "month", sql: "%Y-%m", js: "YYYY-MM" };
}

/** The window of the same length that ends the day before `from` (compare). */
function previousWindow(from, to) {
    const days = daysInclusive(from, to);
    const prevTo = day(from).subtract(1, "day");
    const prevFrom = prevTo.clone().subtract(days - 1, "days");
    const range = {
        from: prevFrom.format("YYYY-MM-DD"),
        to: prevTo.format("YYYY-MM-DD"),
    };
    return { ...range, ...bounds(range.from, range.to) };
}

/**
 * The windows of a snapshot page (Inventory), counted back from now (plan §3.3):
 * - dead_cutoff: now − deadDays, same wall-clock time;
 * - mover window: the last moverDays calendar days, today included, as half-open bounds
 *   [today − (moverDays − 1) 00:00:00, tomorrow 00:00:00).
 * `today` is the Beirut calendar day, for daysBetween().
 */
function relativeWindows(deadDays, moverDays, now = nowBeirut()) {
    const today = now.format("YYYY-MM-DD");
    return {
        today,
        dead_cutoff: now.clone().subtract(deadDays, "days").format("YYYY-MM-DD HH:mm:ss"),
        mover_lo: `${day(today).subtract(moverDays - 1, "days").format("YYYY-MM-DD")} 00:00:00`,
        mover_hi: `${day(today).add(1, "day").format("YYYY-MM-DD")} 00:00:00`,
    };
}

/** Calendar days from one 'YYYY-MM-DD' to another (toDay − fromDay; negative if before). */
const daysBetween = (fromDay, toDay) => day(toDay).diff(day(fromDay), "days");

/**
 * Every bucket key of a trend from `from` to `to` (inclusive days), in order, in the
 * granularity's own format ('YYYY-MM-DD HH:00' | 'YYYY-MM-DD' | 'YYYY-MM'), for
 * zero-filling. Keys are wall-clock labels, so every day has 24 hours.
 */
function bucketKeys(from, to, unit) {
    if (unit === "month") return monthsBetween(from.slice(0, 7), to.slice(0, 7));
    const keys = [];
    for (let d = day(from); d.format("YYYY-MM-DD") <= to; d.add(1, "day")) {
        const date = d.format("YYYY-MM-DD");
        if (unit === "day") keys.push(date);
        else for (let h = 0; h < 24; h++) keys.push(`${date} ${String(h).padStart(2, "0")}:00`);
    }
    return keys;
}

// ---------------------------------------------------------------- months (settlement)

// 'YYYY-MM' months, as plain integers (year × 12 + month − 1): a month has no time zone
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthAt = (i) =>
    `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;

/** A strict 'YYYY-MM' month, else 400 BAD_RANGE naming `field`. */
function parseMonth(value, field) {
    if (typeof value !== "string" || !MONTH_RE.test(value)) {
        throw badRange(field, "Pick a valid month.");
    }
    return value;
}

/** The Beirut month of `now`, 'YYYY-MM'. */
const monthOf = (now = nowBeirut()) => now.format("YYYY-MM");

/** The last full (closed) Beirut month before `now`'s, 'YYYY-MM'. */
const lastFullMonth = (now = nowBeirut()) => monthAt(monthIndex(monthOf(now)) - 1);

/** The month `n` months after `m` (before it when `n` is negative), 'YYYY-MM'. */
const addMonths = (m, n) => monthAt(monthIndex(m) + n);

/** Half-open wall-clock bounds of a month: [m-01 00:00:00, next month-01 00:00:00). */
const monthBounds = (m) => ({
    lo: `${m}-01 00:00:00`,
    hi: `${monthAt(monthIndex(m) + 1)}-01 00:00:00`,
});

/** Every month from `a` to `b`, both included, oldest first ([] when a > b). */
function monthsBetween(a, b) {
    const months = [];
    for (let i = monthIndex(a); i <= monthIndex(b); i++) months.push(monthAt(i));
    return months;
}

module.exports = {
    TZ,
    nowBeirut,
    nowString,
    parseRange,
    bounds,
    granularity,
    previousWindow,
    relativeWindows,
    daysBetween,
    bucketKeys,
    parseMonth,
    monthOf,
    lastFullMonth,
    addMonths,
    monthBounds,
    monthsBetween,
};
