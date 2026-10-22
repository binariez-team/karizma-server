// Coded errors of the reports v2 endpoints (and of /auth/verify-reports-password).
//
// The client maps on `code`, so every refusal answers { code, message, field?,
// retry_after? } at the top level of the body, sent straight from here. A ReportError
// must NEVER reach next() / the global errorHandler: its production branch only sends
// { status, message } (code and retry_after would be lost), and it would read `code` as
// a MySQL error code. Controllers wrap each handler:
//
//     catch (e) { if (e instanceof ReportError) return sendReportError(res, e); next(e); }
//
// so only unexpected errors (DB down, bugs) reach errorHandler, as a generic 500.

class ReportError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message);
        this.name = "ReportError";
        this.status = status;
        this.code = code;
        if (extra.field !== undefined) this.field = extra.field;
        if (extra.retry_after !== undefined) this.retry_after = extra.retry_after;
    }
}

const sendReportError = (res, err) => {
    const body = { code: err.code, message: err.message };
    if (err.field !== undefined) body.field = err.field;
    if (err.retry_after !== undefined) body.retry_after = err.retry_after;
    return res.status(err.status).json(body);
};

// One place for the fixed codes and wording (the client shows `message` as is)
const relogin = () => new ReportError(401, "RELOGIN", "Please log in again.");
const noReports = () =>
    new ReportError(403, "NO_REPORTS", "Reports are not enabled for your account.");
const reportsLocked = () =>
    new ReportError(
        403,
        "REPORTS_LOCKED",
        "Reports are locked. Enter the reports password.",
    );
const scopeForbidden = () =>
    new ReportError(403, "SCOPE_FORBIDDEN", "You can only view your own shop.");
const badScope = () =>
    new ReportError(400, "BAD_SCOPE", "Unknown shop.", { field: "scope" });
const badRange = (field, message) =>
    new ReportError(400, "BAD_RANGE", message, { field });
const badRequest = (field, message) =>
    new ReportError(400, "BAD_REQUEST", message, { field });
const tooManyAttempts = (retry_after) =>
    new ReportError(
        429,
        "TOO_MANY_ATTEMPTS",
        "Too many attempts. Try again later.",
        { retry_after },
    );

module.exports = {
    ReportError,
    sendReportError,
    relogin,
    noReports,
    reportsLocked,
    scopeForbidden,
    badScope,
    badRange,
    badRequest,
    tooManyAttempts,
};
