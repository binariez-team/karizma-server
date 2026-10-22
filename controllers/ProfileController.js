const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/UserModel");
const { ACCESS_SECRET } = require("../config/jwt");

// ******************************************* Profile Methods ***********************************

// update profile username. The new token carries exactly the claims of
// AuthController.login — user_id, database_id, username, user_type — read from the
// login's row, so it works everywhere the login token did.
exports.updateProfile = async (req, res, next) => {
    const { user_id } = req.user;
    let { new_username } = req.body;
    try {
        // mysql2 expands an object bound to `?` (or in `SET ?`) into SQL, so only a
        // non-empty string reaches the queries; the profile form always sends one
        if (typeof new_username !== "string" || new_username === "") {
            return res.status(400).send({ message: "Username is required" });
        }

        let [validateUser] = await User.getByIdAndUsername(
            user_id,
            new_username
        );
        if (validateUser) {
            res.status(406).send({ message: "Username already exists" });
        } else {
            let newUser = {
                user_id: user_id,
                username: new_username,
            };
            await User.update(newUser);
            let [result] = await User.getById(user_id);
            const token = jwt.sign(
                {
                    user_id: result.user_id.toString(),
                    database_id: result.database_id,
                    username: new_username,
                    user_type: result.user_type,
                },
                ACCESS_SECRET
            );
            const updatedUser = {
                username: new_username,
                first_name: result.first_name,
                user_type: result.user_type,
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
            res.status(200).send(updatedUser);
        }
    } catch (error) {
        next(error);
    }
};

// update profile password
exports.updatePassword = async (req, res, next) => {
    const { user_id } = req.user;
    let data = req.body;
    try {
        let [result] = await User.getByPassword(user_id);

        const verified = bcrypt.compareSync(
            data.current_password,
            result.password
        );
        if (verified) {
            await User.updatePassword(user_id, data.new_password);
            res.status(201).send({ message: "Password updated successfully!" });
        } else {
            res.status(406).send({ message: "old password is incorrect!" });
        }
    } catch (error) {
        next(error);
    }
};
