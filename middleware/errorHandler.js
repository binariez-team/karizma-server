const fs = require("fs");
const path = require("path");

/**
 * Custom operational error class to represent expected client/system errors.
 */
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }
}

// Perform synchronous directory/file setup ONCE during module startup, NOT in the request path!
const errorDirectory = path.join(__dirname, "../errors");
const errorLogPath = path.join(errorDirectory, "error.log");

try {
    if (!fs.existsSync(errorDirectory)) {
        fs.mkdirSync(errorDirectory, { recursive: true });
    }
    if (!fs.existsSync(errorLogPath)) {
        fs.writeFileSync(errorLogPath, "");
    }
} catch (fsErr) {
    console.error("Failed to initialize error log directory/file:", fsErr);
}

/**
 * Helper to log error details to the local log file asynchronously.
 */
const logErrorToFile = (err, req) => {
    const timestamp = new Date().toISOString();
    const method = req.method || "N/A";
    const url = req.originalUrl || req.url || "N/A";
    const userId = req.user
        ? req.user.user_id || req.user.id || "Anonymous"
        : "Anonymous";

    // Sanitize body to avoid logging sensitive credentials like passwords
    let bodyString = "N/A";
    if (req.body && Object.keys(req.body).length > 0) {
        const sanitizedBody = { ...req.body };
        const sensitiveKeys = [
            "password",
            "token",
            "accessToken",
            "oldPassword",
            "newPassword",
        ];
        sensitiveKeys.forEach((key) => {
            if (key in sanitizedBody) sanitizedBody[key] = "********";
        });
        bodyString = JSON.stringify(sanitizedBody);
    }

    const logMessage = `----------------------------------------
Timestamp : ${timestamp}
Endpoint  : ${method} ${url}
User ID   : ${userId}
Payload   : ${bodyString}
Error     : ${err.message || err}
Stack     : ${err.stack || "No stack trace available"}
\n`;

    fs.appendFile(errorLogPath, logMessage, (appendErr) => {
        if (appendErr) {
            console.error("Failed to write to log file:", appendErr);
        }
    });
};

/**
 * Handles database (MySQL) errors and turns them into operational AppErrors.
 */
const handleDatabaseError = (err) => {
    // MySQL duplicate entry error
    if (err.errno === 1062 || err.code === "ER_DUP_ENTRY") {
        const value = err.sqlMessage
            ? err.sqlMessage.match(/(["'])(\\?.)*?\1/)
            : null;
        const matchedVal = value ? value[0] : "";
        return new AppError(
            `Duplicate field value: ${matchedVal}. Please use another value!`,
            409,
        );
    }

    // MySQL foreign key constraint failure on delete/update
    if (err.errno === 1451 || err.code === "ER_ROW_IS_REFERENCED_2") {
        return new AppError(
            "This record cannot be deleted or updated because it is referenced by other items in the system.",
            400,
        );
    }

    // MySQL foreign key constraint failure on insert/update
    if (err.errno === 1452 || err.code === "ER_NO_REFERENCED_ROW_2") {
        return new AppError(
            "The referenced parent record was not found. Please verify associated IDs.",
            400,
        );
    }

    // Return original error if it's not a mapped DB constraint
    return err;
};

/**
 * Handles JSON Web Token signature/verification errors.
 */
const handleJWTError = () =>
    new AppError("Invalid authentication token. Please log in again.", 401);

/**
 * Handles JSON Web Token expiration.
 */
const handleJWTExpiredError = () =>
    new AppError("Your session has expired. Please log in again.", 401);

/**
 * Handles JSON Body syntax errors (malformed input).
 */
const handleJSONSyntaxError = () =>
    new AppError("Malformed JSON request body.", 400);

/**
 * Sends detailed error feedback in Development environment.
 */
const sendErrorDev = (err, req, res) => {
    res.status(err.statusCode || 500).json({
        status: err.status || "error",
        error: err,
        message: err.message,
        stack: err.stack,
    });
};

/**
 * Sends clean, user-friendly feedback in Production environment.
 */
const sendErrorProd = (err, req, res) => {
    // 1) Operational, trusted error: send user-friendly message to client
    if (err.isOperational) {
        return res.status(err.statusCode).json({
            status: err.status,
            message: err.message,
        });
    }

    // 2) Programming or other unknown error: don't leak implementation details
    console.error("CRITICAL UNEXPECTED ERROR 💥:", err);
    res.status(500).json({
        status: "error",
        message: "Something went wrong on our end. Please try again later.",
    });
};

/**
 * Main global error handling middleware.
 */
const errorHandler = (err, req, res, next) => {
    // Log the error to console for development visibility
    console.error(err);

    // Asynchronously log full error details to errors/error.log
    logErrorToFile(err, req);

    err.statusCode = err.statusCode || 500;
    err.status = err.status || "error";

    const env = process.env.NODE_ENV || "development";

    if (env === "development") {
        let error = { ...err };
        error.message = err.message;
        error.stack = err.stack;

        // Apply specific mappings in development too for testability
        if (err.errno || err.code) error = handleDatabaseError(error);
        if (err.name === "JsonWebTokenError") error = handleJWTError();
        if (err.name === "TokenExpiredError") error = handleJWTExpiredError();
        if (err instanceof SyntaxError && err.status === 400 && "body" in err)
            error = handleJSONSyntaxError();

        sendErrorDev(error, req, res);
    } else {
        let error = { ...err };
        error.message = err.message;
        error.stack = err.stack;

        // Map technical errors to operational errors in production
        if (err.errno || err.code) error = handleDatabaseError(error);
        if (err.name === "JsonWebTokenError") error = handleJWTError();
        if (err.name === "TokenExpiredError") error = handleJWTExpiredError();
        if (err instanceof SyntaxError && err.status === 400 && "body" in err)
            error = handleJSONSyntaxError();

        sendErrorProd(error, req, res);
    }
};

// Export errorHandler as the default export, and AppError as a secondary export
module.exports = errorHandler;
module.exports.AppError = AppError;
