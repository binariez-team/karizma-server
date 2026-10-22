const pool = require("../../config/database");
const { asMoney } = require("./money");
const { badScope, scopeForbidden } = require("./errors");

// Which shops (tenants) a report covers (plan §3.2, D9, D12).
//
// Only the admin chooses: Combined (every tenant, inactive ones included, D17), his own
// shop, or any one tenant of the directory. Users and staff only ever see their own
// tenant; anything else they ask for is refused before a report query runs.
//
// Runs after middleware/reportsAccess.js, which set req.reports and already refused a
// token without database_id.

// Every tenant with an admin or user login (staff-only rows are not shops). EXISTS gives
// BIGINT 0/1, which the pool's TINYINT(1) cast does not touch: normalised below.
const DIRECTORY_SQL = `/* rk:scope.directory */
SELECT d.database_id, d.database_name, d.profit_share_pct, d.assets_cap_usd,
  EXISTS (SELECT 1 FROM users a WHERE a.database_id = d.database_id AND a.user_type = 'admin') AS has_admin,
  EXISTS (SELECT 1 FROM users u WHERE u.database_id = d.database_id AND u.user_type = 'user' AND u.is_deleted = 0) AS has_live_user
FROM user_database d
WHERE EXISTS (SELECT 1 FROM users x WHERE x.database_id = d.database_id AND x.user_type IN ('admin','user'))
ORDER BY d.database_id`;

const flag = (v) => Boolean(Number(v));

/** The tenant directory, ordered by database_id. No cache: a tiny query. */
async function loadDirectory() {
    const [rows] = await pool.query(DIRECTORY_SQL);
    return rows.map((row) => ({
        database_id: Number(row.database_id),
        database_name: row.database_name,
        profit_share_pct: row.profit_share_pct,
        assets_cap_usd: row.assets_cap_usd,
        has_admin: flag(row.has_admin),
        has_live_user: flag(row.has_live_user),
    }));
}

const KEYWORDS = new Set(["own", "combined", "admin"]);

// The raw `scope` (query string or body) as { kind: 'absent'|'own'|'combined'|'admin' }
// or { kind: 'id', id }. Anything else — an object (?scope[x]=1), an array (?scope[]=1
// or a repeated ?scope=), a boolean, 0, a negative, a float, any other string — is
// 400 BAD_SCOPE, and never reaches `?`.
function classify(raw) {
    if (raw === undefined || raw === null || raw === "") return { kind: "absent" };
    if (typeof raw === "string" && KEYWORDS.has(raw)) return { kind: raw };

    const id =
        typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))
            ? Number(raw)
            : NaN;
    if (Number.isSafeInteger(id) && id > 0) return { kind: "id", id };
    throw badScope();
}

/**
 * Resolve the requested scope for this viewer.
 *
 * | viewer       | scope                              | result                                |
 * |--------------|------------------------------------|---------------------------------------|
 * | user / staff | absent, 'own', own id              | own tenant, key String(own)           |
 * | user / staff | 'combined', 'admin', any other id  | 403 SCOPE_FORBIDDEN (no query)        |
 * | admin        | absent, 'combined'                 | every directory id, key 'combined'    |
 * | admin        | 'admin', 'own', own id             | own tenant, key 'admin' (one key)     |
 * | admin        | another id in the directory        | that tenant, key String(id)           |
 * | admin        | an id not in the directory         | 400 BAD_SCOPE                         |
 *
 * `database_ids` is never empty. `directory` is returned when it was read (so the
 * caller does not read it twice), else null.
 *
 * @returns {Promise<{ key: string, mode: 'combined'|'single', database_ids: number[],
 *   directory: Array|null }>}
 */
async function resolveScope(req, raw) {
    const scope = classify(raw);
    const { isAdmin, databaseId: own } = req.reports;
    const isOwnId = scope.kind === "id" && scope.id === own;

    if (!isAdmin) {
        if (scope.kind === "absent" || scope.kind === "own" || isOwnId) {
            return { key: String(own), mode: "single", database_ids: [own], directory: null };
        }
        throw scopeForbidden();
    }

    if (scope.kind === "admin" || scope.kind === "own" || isOwnId) {
        return { key: "admin", mode: "single", database_ids: [own], directory: null };
    }

    const directory = await loadDirectory();

    if (scope.kind === "absent" || scope.kind === "combined") {
        const ids = directory.map((t) => t.database_id);
        return {
            key: "combined",
            mode: "combined",
            database_ids: ids.length ? ids : [own],
            directory,
        };
    }

    if (!directory.some((t) => t.database_id === scope.id)) throw badScope();
    return {
        key: String(scope.id),
        mode: "single",
        database_ids: [scope.id],
        directory,
    };
}

/**
 * The `tenants` array of every response: the whole directory for the admin (so the
 * chips can render, whatever the scope), only the viewer's own row for anyone else
 * (empty if that row is somehow missing).
 *
 * color_index is fixed per tenant: 0 for the admin's tenant, then 1..n in database_id
 * order over the FULL directory, inactive tenants included, so a shop's colour never
 * shifts with the scope or the "+ inactive" toggle.
 */
function buildTenants(directory, req) {
    const { isAdmin, databaseId } = req.reports;
    const sorted = [...directory].sort((a, b) => a.database_id - b.database_id);

    // The admin's tenant is the admin caller's own (A11); other viewers do not know
    // it, so it is the tenant with an admin login.
    const isAdminTenant = (t) => (isAdmin ? t.database_id === databaseId : t.has_admin);
    const adminTenantId = sorted.find(isAdminTenant)?.database_id ?? null;

    let nextColor = 1;
    const rows = sorted.map((t) => ({
        database_id: t.database_id,
        name: String(t.database_name ?? "").trim(),
        role: isAdminTenant(t) ? "admin" : "user",
        active: t.has_admin || t.has_live_user,
        color_index: t.database_id === adminTenantId ? 0 : nextColor++,
        share_pct: asMoney(t.profit_share_pct),
        assets_cap_usd: asMoney(t.assets_cap_usd),
    }));

    return isAdmin ? rows : rows.filter((t) => t.database_id === databaseId);
}

module.exports = { loadDirectory, classify, resolveScope, buildTenants };
