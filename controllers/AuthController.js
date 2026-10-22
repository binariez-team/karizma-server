const jwt = require("jsonwebtoken");
const User = require("../models/UserModel");
const SystemSecret = require("../models/SystemSecretModel");
const bcrypt = require("bcryptjs");
const { ACCESS_SECRET } = require("../config/jwt");
const access = require("../models/reports-v2/access");
const {
    ReportError,
    sendReportError,
    noReports,
    tooManyAttempts,
} = require("../models/reports-v2/errors");

const NO_OWNER_MESSAGE =
    "This staff login is disabled because its shop has no owner account. Please contact the administrator.";

exports.login = async (req, res, next) => {
    const io = req.io;
    try {
        const { username, password } = req.body;

        // Strings only: mysql2 expands an object bound to `?` into SQL
        if (
            !(username && password) ||
            typeof username !== "string" ||
            typeof password !== "string"
        ) {
            return res.status(400).send("All fields are required!");
        }
        let result = await User.getByUsernameAndPassword(username, password);
        // No staff without an owner (UserModel). Refused only once the password proved
        // right: a wrong one still gets the same 401 as an unknown username, so this
        // answer never tells a stranger that the login exists.
        if (result && User.isOrphanStaff(result)) {
            return res.status(403).send({ message: NO_OWNER_MESSAGE });
        }
        if (result) {
            const token = jwt.sign(
                {
                    user_id: result.user_id.toString(),
                    database_id: result.database_id,
                    username,
                    user_type: result.user_type,
                },
                ACCESS_SECRET
            );

            const user = {
                username: username,
                first_name: result.first_name,
                user_type: result.user_type,
                database_id: result.database_id,
                token: token,
                permissions: {
                    view_purchases: result.view_purchases,
                    view_stock: result.view_stock,
                    edit_invoice: result.edit_invoice,
                    view_reports: result.view_reports,
                    deliver_items: result.deliver_items,
                    view_expenses: result.view_expenses,
                    view_cash: result.view_cash,
                    view_cost: result.view_cost,
                    transfer_money: result.transfer_money,
                    edit_stock: result.edit_stock,
                    correct_debt: result.correct_debt,
                },
            };
            if (user.user_type !== "admin") {
                io.emit("userLoggedIn", username);
            }

            res.status(200).send(user);
        } else {
            res.status(401).send("Incorrect username or password!");
        }
    } catch (error) {
        next(error);
    }
};

/**
 * Verify the reports password and hand out the reports unlock token (plan §4.2).
 *
 * The token (x-reports-token) is what the /reports/v2 gate checks; it lasts 1 hour and
 * dies when the password changes. Older desktop builds only read `success`, so the
 * 200 / 401 bodies keep their old shape. Refusals before the password is looked at
 * (RELOGIN, NO_REPORTS, TOO_MANY_ATTEMPTS) answer with their code at the top level.
 */
exports.verifyReportsPassword = async (req, res, next) => {
    try {
        // Live users row: token still matches (else 401 RELOGIN)
        const viewer = await access.loadViewer(req);

        if (!viewer.isAdmin && !viewer.viewReports) {
            return sendReportError(res, noReports());
        }

        // 5 wrong passwords in 10 minutes block further attempts, checked before
        // bcrypt so a blocked caller cannot keep guessing (a right password included)
        const throttle = access.limiter.check(viewer.userId);
        if (throttle.blocked) {
            return sendReportError(res, tooManyAttempts(throttle.retry_after));
        }

        const { password } = req.body || {};

        // Not counted as a failed attempt
        if (typeof password !== "string" || password === "") {
            return res.status(400).json({ message: "Password is required!" });
        }

        // Counted before the password is looked up, with no await since check(), so
        // parallel requests cannot all pass the throttle while the first ones are still
        // in bcrypt. A correct password clears the entry again.
        access.limiter.fail(viewer.userId);

        const isValid = await SystemSecret.verifySecret("reports_password", password);

        if (isValid) {
            access.limiter.clear(viewer.userId);
            const { token, expires_in } = await access.signReportsToken({
                userId: viewer.userId,
                databaseId: viewer.databaseId,
            });
            return res.status(200).json({
                success: true,
                message: "Password verified.",
                reports_token: token,
                expires_in,
            });
        } else {
            return res.status(401).json({ success: false, message: "Incorrect password!" });
        }
    } catch (error) {
        if (error instanceof ReportError) return sendReportError(res, error);
        next(error);
    }
};

/**
 * Change the reports password (admin only: routes/auth.routes.js)
 */
exports.changeReportsPassword = async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: "Current and new passwords are required!" });
        }

        // 1. Verify current password
        const isCurrentValid = await SystemSecret.verifySecret("reports_password", currentPassword);

        if (!isCurrentValid) {
            return res.status(401).json({ success: false, message: "Current password is incorrect!" });
        }

        // 2. Update to new password
        await SystemSecret.updateSecret("reports_password", newPassword);

        // The new hash changes the password version: every reports unlock token
        // issued so far stops working on its next request
        access.clearPasswordVersion();

        return res.status(200).json({ success: true, message: "Password updated successfully!" });
    } catch (error) {
        next(error);
    }
};
