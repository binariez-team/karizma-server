const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../../config/database");
const { REPORTS_SECRET } = require("../../config/jwt");
const { relogin } = require("./errors");

// The reports password gate (plan §4.2): the live viewer row, the reports unlock token,
// the password version that ties every token to the current password, and the verify
// rate limiter. Used by middleware/reportsAccess.js and AuthController.

const TOKEN_TTL = 3600; // seconds; an unlock lasts 1 hour (D10)
const PV_TTL_MS = 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;

// Same rule as QuotationModel.isId: only whole positive numbers reach `?`
const isId = (v) =>
    (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) &&
    Number.isSafeInteger(Number(v)) &&
    Number(v) > 0;

/**
 * The caller's live users row, checked against the access token.
 *
 * The token is frozen at login and has no expiry, so it can outlive a deleted login, a
 * changed role or a moved tenant; and a username change made before the profile fix
 * re-signed it WITHOUT database_id (ProfileController.updateProfile now signs the login
 * claims, and middleware/auth.js refuses such tokens first). All of those are refused
 * with RELOGIN. Permission flags are read here, never from the token or the client.
 *
 * No staff without an owner (models/UserModel.js): a staff login's view_reports only
 * counts while its shop has an admin login or a live user login, so the staff of a
 * deleted owner get NO_REPORTS (403) from the gate and from the password verify, and
 * never reach a report (a shop with no admin or user login at all is not in the
 * directory: its report had no shop name, and Financial failed with a 500). Worked out
 * in the same query, so the gate still costs one read.
 *
 * @returns {Promise<{ userId: string, databaseId: number, userType: string,
 *   isAdmin: boolean, viewReports: boolean, viewCost: boolean }>}
 */
async function loadViewer(req) {
    const user = req.user || {};
    // A null/missing database_id is a pre-fix username-change token; anything that is
    // not a plain id is refused the same way before it can reach `?`.
    if (!isId(user.user_id) || !isId(user.database_id)) throw relogin();

    // view_reports: the flag AND (not staff OR the shop has an owner) — BIGINT 0/1
    const [[row]] = await pool.query(
        `/* rk:access.user */ SELECT u.user_type, u.database_id, u.view_cost, u.is_deleted,
          (u.view_reports AND (u.user_type <> 'staff' OR EXISTS (
            SELECT 1 FROM users o WHERE o.database_id = u.database_id
              AND (o.user_type = 'admin' OR (o.user_type = 'user' AND o.is_deleted = 0))
          ))) AS view_reports
        FROM users u WHERE u.user_id = ?`,
        [Number(user.user_id)],
    );
    // TINYINT(1) arrives as a boolean (config/database.js typeCast); Number() also
    // copes with 0/1.
    if (
        !row ||
        Number(row.is_deleted) ||
        row.user_type !== user.user_type ||
        Number(row.database_id) !== Number(user.database_id)
    ) {
        throw relogin();
    }

    return {
        userId: String(user.user_id),
        databaseId: Number(user.database_id),
        userType: row.user_type,
        isAdmin: row.user_type === "admin",
        viewReports: Boolean(Number(row.view_reports)),
        viewCost: Boolean(Number(row.view_cost)),
    };
}

// ---------------------------------------------------------------- password version

// pv = the first 16 hex chars of sha256(bcrypt hash of the reports password). Every
// change re-hashes with a new salt (SystemSecret.updateSecret), so pv changes and every
// outstanding unlock token dies. Cached for 60 s; the change endpoint clears it, so in
// this single-process server the invalidation is immediate.
//
// Own query rather than SystemSecret.getByName: system_secrets has no UNIQUE key on
// secret_name, so the row is picked deterministically. No row → null → every non-admin
// stays locked.
let pvCache = null; // { value, at }
// Bumped by every clear: a read that was already in flight when the password changed
// must not cache the old version again afterwards.
let pvGeneration = 0;

async function passwordVersion() {
    const now = Date.now();
    if (pvCache && now - pvCache.at < PV_TTL_MS) return pvCache.value;

    const generation = pvGeneration;
    const [rows] = await pool.query(
        `/* rk:access.pv */ SELECT secret_hash FROM system_secrets
        WHERE secret_name = 'reports_password' ORDER BY secret_id LIMIT 1`,
    );
    const hash = rows[0]?.secret_hash;
    const value = hash
        ? crypto.createHash("sha256").update(String(hash)).digest("hex").slice(0, 16)
        : null;
    if (generation === pvGeneration) pvCache = { value, at: now };
    return value;
}

function clearPasswordVersion() {
    pvCache = null;
    pvGeneration++;
}

// ---------------------------------------------------------------- unlock token

// { typ:'reports', uid, db, pv } signed with REPORTS_SECRET (never the access secret),
// exp − iat = 3600.
async function signReportsToken({ userId, databaseId }) {
    const pv = await passwordVersion();
    const token = jwt.sign(
        { typ: "reports", uid: String(userId), db: Number(databaseId), pv },
        REPORTS_SECRET,
        { algorithm: "HS256", expiresIn: TOKEN_TTL },
    );
    return { token, expires_in: TOKEN_TTL };
}

// true only for an unexpired token of this user, this tenant and the current password.
// Any jwt error (expired, bad signature, malformed, wrong algorithm) is just `false`:
// the gate answers REPORTS_LOCKED, never errorHandler's 401 "session expired".
async function verifyReportsToken(tok, req) {
    if (typeof tok !== "string" || tok === "") return false;

    let payload;
    try {
        payload = jwt.verify(tok, REPORTS_SECRET, { algorithms: ["HS256"] });
    } catch (error) {
        return false;
    }

    if (!payload || typeof payload !== "object") return false;
    // jwt.verify accepts a token with no exp at all; ours always carry exp − iat = 3600
    if (
        typeof payload.exp !== "number" ||
        typeof payload.iat !== "number" ||
        payload.exp - payload.iat > TOKEN_TTL
    ) {
        return false;
    }
    if (payload.typ !== "reports") return false;
    if (payload.uid !== String(req.user.user_id)) return false;
    if (payload.db !== Number(req.user.database_id)) return false;

    const pv = await passwordVersion();
    return pv !== null && payload.pv === pv;
}

// ---------------------------------------------------------------- verify rate limit

// In-memory failure timestamps per user_id: 5 wrong passwords within 10 minutes block
// further attempts (a correct one included) until the window frees a slot. Checked,
// and the attempt counted, before bcrypt runs (a correct password then clears it).
// Resets on restart, which is acceptable for one process.
const failures = new Map(); // String(user_id) -> number[] (ms, oldest first)

function recent(key, now) {
    const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
}

const limiter = {
    check(uid, now = Date.now()) {
        const list = recent(String(uid), now);
        if (list.length < MAX_FAILURES) return { blocked: false, retry_after: 0 };
        // Seconds until the window holds fewer than MAX_FAILURES again. With exactly
        // MAX_FAILURES entries (the normal case) this is the oldest one's expiry.
        const freesAt = list[list.length - MAX_FAILURES] + WINDOW_MS;
        return {
            blocked: true,
            retry_after: Math.max(1, Math.ceil((freesAt - now) / 1000)),
        };
    },
    fail(uid, now = Date.now()) {
        const key = String(uid);
        const list = recent(key, now);
        list.push(now);
        failures.set(key, list);
    },
    clear(uid) {
        failures.delete(String(uid));
    },
};

module.exports = {
    TOKEN_TTL,
    loadViewer,
    passwordVersion,
    clearPasswordVersion,
    signReportsToken,
    verifyReportsToken,
    limiter,
};
