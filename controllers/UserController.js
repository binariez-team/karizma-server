const User = require("../models/UserModel");

// users.edit_stock / users.correct_debt are TINYINT(1) NOT NULL DEFAULT 0. The dialog
// sends a boolean; a null (e.g. from a client built before the toggle existed) would
// fail the write under STRICT_TRANS_TABLES, so coerce whatever arrives to 0/1.
const normalizePermissions = (user) => {
    if ("edit_stock" in user) user.edit_stock = user.edit_stock ? 1 : 0;
    if ("correct_debt" in user) user.correct_debt = user.correct_debt ? 1 : 0;
};

// get users
exports.getUsers = async (req, res, next) => {
    try {
        let users = await User.getAll();
        res.status(200).send(users);
    } catch (error) {
        next(error);
    }
};

// create user
exports.createUser = async (req, res, next) => {
    try {
        const user = req.body;
        // validate if username already taken
        let [validateUser] = await User.getByUsername(user.username);
        if (validateUser) {
            res.status(406).send({ message: "Username already exists" });
        } else {
            // create user
            normalizePermissions(user);
            let result = await User.create(user);
            let [createdUser] = await User.getForAdmin(result.insertId);
            res.status(201).send(createdUser);
        }
    } catch (error) {
        next(error);
    }
};

// update user
exports.updateUser = async (req, res, next) => {
    const user = req.body;
    delete user.password;
    delete user.confirm_password;
    try {
        let [validateUser] = await User.getByIdAndUsername(
            user.user_id,
            user.username
        );
        if (validateUser) {
            res.status(406).send({ message: "Username already exists" });
        } else {
            // Take the tenant from the row, not the request. The dialog carries
            // database_id as a hidden form value; a stale one would move this user
            // into another tenant, and User.update would rename that tenant's
            // database to this username.
            const [existing] = await User.getForAdmin(user.user_id);
            if (!existing) {
                return res.status(404).send({ message: "User not found" });
            }
            user.database_id = existing.database_id;

            normalizePermissions(user);
            await User.update(user);
            const [updatedUser] = await User.getForAdmin(user.user_id);
            res.status(201).send(updatedUser);
        }
    } catch (error) {
        next(error);
    }
};

// delete user
exports.deleteUser = async (req, res, next) => {
    const { id } = req.params;
    try {
        await User.delete(id);
        res.status(201).send({ message: "User deleted successfully!" });
    } catch (error) {
        next(error);
    }
};
