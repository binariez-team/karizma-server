const jwt = require("jsonwebtoken");
const User = require("../models/UserModel");

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
