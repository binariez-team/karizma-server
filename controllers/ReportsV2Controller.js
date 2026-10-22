const { ReportError, sendReportError } = require("../models/reports-v2/errors");
const {
    loadDirectory,
    resolveScope,
    buildTenants,
} = require("../models/reports-v2/scope");
const { strip } = require("../models/reports-v2/costStrip");
const { nowString, nowBeirut } = require("../models/reports-v2/dates");
const { parseInventoryBody, getInventory } = require("../models/reports-v2/inventory");
const { parseLookupsBody, getLookups } = require("../models/reports-v2/lookups");
const { parseOverviewBody, getOverview } = require("../models/reports-v2/overview");
const { parseFinancialBody, getFinancial } = require("../models/reports-v2/financial");
const {
    parseBalanceSheetBody,
    getBalanceSheet,
} = require("../models/reports-v2/balanceSheet");
const {
    parseProductsTableBody,
    parseProductsRollupBody,
    getProductsTable,
    getProductsRollup,
} = require("../models/reports-v2/products");
const {
    parseLinesBody,
    parseProductBody,
    parseLedgerBody,
    getLines,
    getProduct,
    getLedger,
} = require("../models/reports-v2/productHistory");
const { parseBusyHoursBody, getBusyHours } = require("../models/reports-v2/busyHours");

// Reports v2 (plan §3, §6). Mounted behind `auth` + reportsAccess, so req.reports is
// set. Each handler: parse → resolve scope → model → strip → send. Coded refusals
// (ReportError) are answered with their { code, message, ... } body; anything else goes
// to the global errorHandler as a generic 500.

const fail = (error, res, next) =>
    error instanceof ReportError ? sendReportError(res, error) : next(error);

// A viewer who is not the admin and has view_cost off (D8). The models use the same
// test to rank by retail and to leave out cost-only notes.
const isRestricted = (req) => !req.reports.isAdmin && !req.reports.viewCost;
exports.isRestricted = isRestricted;

// The JSON body, or {} (express.json leaves a non-object body as is)
const bodyOf = (req) =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

/**
 * Send the common envelope { meta, tenants, ...payload, notes } (plan §3.6).
 *
 * A viewer who is not the admin and has view_cost off is "restricted": the page
 * payload goes through costStrip first (D8). `meta`, `tenants` and `notes` are built
 * separately and never stripped. meta.restricted is true for such a viewer on every
 * response, even when nothing had to be removed. The payload must not use the keys
 * meta, tenants or notes.
 */
function sendEnvelope(req, res, { scope, range = null, tenants, payload, notes = [] }) {
    const restricted = isRestricted(req);
    const page = restricted ? strip(payload) : payload;

    const meta = {
        scope: {
            key: scope.key,
            mode: scope.mode,
            database_ids: scope.database_ids,
        },
        viewer: {
            user_type: req.reports.userType,
            is_admin: req.reports.isAdmin,
        },
        range: range
            ? { from: range.from, to: range.to, lo: range.lo, hi: range.hi }
            : null,
        generated_at: nowString(),
        restricted,
    };

    return res.status(200).json({ meta, tenants, ...page, notes });
}

// GET /reports/v2/tenants?scope= — the shop directory for the scope chips (admin) or
// the "Shop: name" tag (users and staff). The admin gets every tenant whatever the
// scope; anyone else only his own row, read after his scope was accepted.
exports.tenants = async (req, res, next) => {
    try {
        const scope = await resolveScope(req, req.query.scope);
        const directory = scope.directory || (await loadDirectory());
        const tenants = buildTenants(directory, req);

        const payload = req.reports.isAdmin
            ? {
                  admin_database_id: req.reports.databaseId,
                  default_scope: "combined",
              }
            : { default_scope: "own" };

        sendEnvelope(req, res, { scope, tenants, payload });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/inventory — stock value, low / out / dead stock, fast movers, highest
// value, stock by shop, in transit and value by category, as of now (plan §6.6). The
// body is checked first, so a bad field costs no query.
exports.inventory = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseInventoryBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getInventory({
            scope,
            params,
            reports: req.reports,
            directory,
            restricted: isRestricted(req),
        });
        sendEnvelope(req, res, {
            scope,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/lookups — the pick lists of the filters. Categories, brands and
// products are global (the scope is resolved so the usual access rules apply);
// customers are those of the scope's shops.
exports.lookups = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseLookupsBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const payload = await getLookups(params, scope.database_ids);
        sendEnvelope(req, res, { scope, tenants: buildTenants(directory, req), payload });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/overview — sales, returns, orders, the trend, the largest documents
// and the top products over a date range, with an optional compare window (plan §6.1).
// The body is checked first, so a bad field costs no query.
exports.overview = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseOverviewBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getOverview({
            scope,
            params,
            directory,
            restricted: isRestricted(req),
        });
        sendEnvelope(req, res, {
            scope,
            range: params.range,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/financial — P&L and profit split, the user shops' profit share per
// month (S9), cash flow, receivables movement and expenses over a date range (plan §6.2).
// The body is checked first (settlement_month against the same Beirut "now" the report
// uses), so a bad field costs no query.
exports.financial = async (req, res, next) => {
    try {
        const now = nowBeirut();
        const body = bodyOf(req);
        const params = parseFinancialBody(body, now);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getFinancial({
            scope,
            params,
            reports: req.reports,
            directory,
            restricted: isRestricted(req),
            now,
        });
        sendEnvelope(req, res, {
            scope,
            range: params.range,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/balance-sheet — what each shop holds and owes, and the assets-cap use
// of each user's shop (plan §6.7): as of now (D16), or at a month end that has a
// month-end snapshot (as_of, plan §8 Phase 7 item 2). A malformed as_of costs no query.
// Phase 7.1: the partner account of each user shop, its current month from `now`.
exports.balanceSheet = async (req, res, next) => {
    try {
        const now = nowBeirut();
        const body = bodyOf(req);
        const params = parseBalanceSheetBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getBalanceSheet({
            scope,
            params,
            reports: req.reports,
            directory,
            restricted: isRestricted(req),
            now,
        });
        sendEnvelope(req, res, {
            scope,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/products/table — one page of products with their sales, returns and
// gross profit over a date range, current stock, and the totals of every matching
// product (plan §6.3). The body is checked first, so a bad field costs no query.
exports.productsTable = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseProductsTableBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getProductsTable({
            scope,
            params,
            directory,
            restricted: isRestricted(req),
        });
        sendEnvelope(req, res, {
            scope,
            range: params.range,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/products/rollup — net sales and gross profit by category and by
// brand over a date range (plan §6.3); a separate request, so paging and sorting the
// table never reload it.
exports.productsRollup = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseProductsRollupBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getProductsRollup({ scope, params });
        sendEnvelope(req, res, {
            scope,
            range: params.range,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/product-history/lines — sale and return lines over a date range,
// optionally of one product, category or customer (plan §6.4 Mode A, and Mode B's
// "Sales & returns" tab). A customer outside the scope is refused before any line query.
exports.historyLines = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseLinesBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getLines({
            scope,
            params,
            directory,
            restricted: isRestricted(req),
        });
        sendEnvelope(req, res, {
            scope,
            range: params.range,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/product-history/product — one product's card per shop and, for a
// viewer who may see cost, its cost trail (plan §6.4 Mode B). Purchases and supplier
// names only for the admin.
exports.historyProduct = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseProductBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getProduct({
            scope,
            params,
            reports: req.reports,
            directory,
            restricted: isRestricted(req),
        });
        sendEnvelope(req, res, {
            scope,
            range: params.range,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/product-history/ledger — one product's stock movements with the
// running balance per shop, over an optional date range (plan §6.4 Mode B).
exports.historyLedger = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseLedgerBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getLedger({
            scope,
            params,
            reports: req.reports,
            directory,
            restricted: isRestricted(req),
        });
        sendEnvelope(req, res, {
            scope,
            range: params.range,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /reports/v2/busy-hours — orders, sales and gross profit by weekday and hour over
// a date range, and each shop's peak time in Combined (plan §6.5). The body is checked
// first, so a bad field costs no query.
exports.busyHours = async (req, res, next) => {
    try {
        const body = bodyOf(req);
        const params = parseBusyHoursBody(body);
        const scope = await resolveScope(req, body.scope);
        const directory = scope.directory || (await loadDirectory());

        const { payload, notes } = await getBusyHours({
            scope,
            params,
            reports: req.reports,
            directory,
            restricted: isRestricted(req),
        });
        sendEnvelope(req, res, {
            scope,
            range: params.range,
            tenants: buildTenants(directory, req),
            payload,
            notes,
        });
    } catch (error) {
        fail(error, res, next);
    }
};
