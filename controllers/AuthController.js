const jwt = require("jsonwebtoken");
const User = require("../models/UserModel");
const SystemSecret = require("../models/SystemSecretModel");
const bcrypt = require("bcryptjs");

exports.login = async (req, res, next) => {
    const io = req.io;
    try {
        const { username, password } = req.body;

        if (!(username && password)) {
            res.status(400).send("All fields are required!");
        }
        let result = await User.getByUsernameAndPassword(username, password);
        if (result) {
            const token = jwt.sign(
                {
                    user_id: result.user_id.toString(),
                    database_id: result.database_id,
                    username,
                    user_type: result.user_type,
                },
                "$3a#_cJDUV-$QsRewWXcyH-Xdji8#%^$*(_ZkfNdI@#!D-Nv0E_M3a"
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
 * Verify the reports password
 */
exports.verifyReportsPassword = async (req, res, next) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ message: "Password is required!" });
        }

        const isValid = await SystemSecret.verifySecret("reports_password", password);

        if (isValid) {
            return res.status(200).json({ success: true, message: "Password verified." });
        } else {
            return res.status(401).json({ success: false, message: "Incorrect password!" });
        }
    } catch (error) {
        next(error);
    }
};

/**
 * Change the reports password
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

        return res.status(200).json({ success: true, message: "Password updated successfully!" });
    } catch (error) {
        next(error);
    }
};
