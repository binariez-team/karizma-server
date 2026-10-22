// Money arithmetic of the reports (plan §3.8).
//
// MySQL hands DECIMAL columns and SUM()s back as strings ("1234.50"). They are turned
// into integer cents WITHOUT going through a float, every sum and difference is done in
// cents, and the response carries strings with exactly 2 decimals. The client never
// adds money up; it only displays these strings.

// Math.round rounds -2.5 to -2; money rounds half away from zero. Never returns -0.
const roundHalfAway = (x) => {
    const r = Math.sign(x) * Math.round(Math.abs(x));
    return r === 0 ? 0 : r;
};

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * A DECIMAL string (or a number, or null) as integer cents, rounded half away from zero
 * at the 3rd decimal: "1.005" → 101, "-1.005" → -101, "12" → 1200, null → 0.
 */
function toCents(value) {
    if (value === null || value === undefined) return 0;

    let text;
    if (typeof value === "string") text = value.trim();
    // toFixed(6) gives the decimal a number was written as (1.005 → "1.005000"), and
    // never an exponent below 1e21
    else if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e15)
        text = value.toFixed(6);
    else if (typeof value === "bigint") text = value.toString();
    else throw new TypeError(`Not a money amount: ${String(value)}`);

    const m = DECIMAL_RE.exec(text);
    if (!m || (m[2] === "" && !m[3])) {
        throw new TypeError(`Not a money amount: ${text}`);
    }

    const fraction = (m[3] || "").padEnd(3, "0");
    let cents = Number(m[2] || "0") * 100 + Number(fraction.slice(0, 2));
    if (fraction.charCodeAt(2) >= 53) cents += 1; // 3rd decimal >= "5"
    if (!Number.isSafeInteger(cents)) {
        throw new RangeError(`Money amount out of range: ${text}`);
    }
    return m[1] === "-" && cents !== 0 ? -cents : cents;
}

/** Integer cents as a 2-decimal string: -123450 → "-1234.50"; never "-0.00". */
function toMoney(cents) {
    if (!Number.isSafeInteger(cents)) {
        throw new TypeError(`Not a whole number of cents: ${String(cents)}`);
    }
    const abs = Math.abs(cents);
    const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
    return cents < 0 ? `-${text}` : text;
}

/** A DECIMAL string normalised to 2 decimals ("50" → "50.00"); null stays null. */
const asMoney = (value) =>
    value === null || value === undefined ? null : toMoney(toCents(value));

/**
 * num / den × 100 with 1 decimal (a JS number), rounded half away from zero;
 * null when the denominator is 0. Both arguments are integer cents.
 */
function pct(numC, denC) {
    if (!denC) return null;
    const tenths = roundHalfAway((numC * 1000) / denC);
    return tenths / 10;
}

/** A percentage string with 2 decimals as basis points: "50.00" → 5000. */
const bp = (pctString) => toCents(pctString);

/**
 * Split a user's net profit (cents) by his share in basis points (plan M14):
 * user = roundHalfAway(np × bp / 10000), admin = np − user, so the two always add up to
 * np exactly. Negative profit gives negative shares (D4). 5 cents at 5000 → 3 / 2.
 * Integer arithmetic only: np × bp stays far inside the safe range for real amounts.
 */
function splitShare(npC, bpValue) {
    const product = npC * bpValue;
    if (!Number.isSafeInteger(product)) {
        throw new RangeError("Profit share out of range");
    }
    const rest = product % 10000; // same sign as product
    let user = (product - rest) / 10000;
    if (Math.abs(rest) * 2 >= 10000) user += Math.sign(product);
    user = user === 0 ? 0 : user;
    const admin = npC - user;
    return { user, admin: admin === 0 ? 0 : admin };
}

module.exports = {
    roundHalfAway,
    toCents,
    toMoney,
    asMoney,
    pct,
    bp,
    splitShare,
};
