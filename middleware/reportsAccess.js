const access = require("../models/reports-v2/access");
const {
    ReportError,
    sendReportError,
    noReports,
    reportsLocked,
} = require("../models/reports-v2/errors");

// Gate of every /reports/v2 endpoint (plan §4.2), mounted after `auth`:
//
//     app.use("/reports/v2", auth, reportsAccess, ReportsV2Routes)
//
// 1. the live users row must still match the token (else 401 RELOGIN);
// 2. the admin passes: he is never asked for the reports password and sees everything;
// 3. users and staff need view_reports (else 403 NO_REPORTS; a staff member's counts only
//    while his shop has an owner, see access.loadViewer) AND a valid unlock token in
//    the x-reports-token header (else 403 REPORTS_LOCKED). The header is the only place
//    it is read from — never the query string or the body.
//
// Sets req.reports = { isAdmin, viewCost, userType, databaseId, userId } for the
// controllers. Refusals are answered here with sendReportError; only unexpected errors
// (DB) go to next(err).
const reportsAccess = async (req, res, next) => {
    try {
        const viewer = await access.loadViewer(req);

        if (viewer.isAdmin) {
            req.reports = {
                isAdmin: true,
                viewCost: true,
                userType: "admin",
                databaseId: viewer.databaseId,
                userId: viewer.userId,
            };
        } else {
            if (!viewer.viewReports) throw noReports();

            const unlocked = await access.verifyReportsToken(
                req.get("x-reports-token"),
                req,
            );
            if (!unlocked) throw reportsLocked();

            req.reports = {
                isAdmin: false,
                viewCost: viewer.viewCost,
                userType: viewer.userType,
                databaseId: viewer.databaseId,
                userId: viewer.userId,
            };
        }
    } catch (error) {
        if (error instanceof ReportError) return sendReportError(res, error);
        return next(error);
    }
    return next();
};

module.exports = reportsAccess;
