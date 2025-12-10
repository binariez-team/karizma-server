const Staff = require("../models/StaffModel");
const User = require("../models/UserModel");

// get all
exports.getAll = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const staff = await Staff.getAll(database_id);
        res.json(staff);
    } catch (error) {
        next(error);
    }
};

// create staff
exports.createStaff = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        let staff = req.body;
        delete staff.user_id;
        delete staff.confirm_password;

        // validate if username already taken
        let [validateUser] = await User.getByUsername(staff.username);
        if (validateUser) {
            res.status(406).send({ message: "Username already exists" });
        } else {
            // create user
            let result = await Staff.create(staff, database_id);
            let [createdStaff] = await Staff.getById(
                result.insertId,
                database_id
            );
            res.status(201).send(createdStaff);
        }
    } catch (error) {
        next(error);
    }
};

// update staff
exports.updateStaff = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        let user = req.body;
        delete user.password;
        delete user.confirm_password;
        let [validateUser] = await User.getByIdAndUsername(
            user.user_id,
            user.username
        );
        if (validateUser) {
            res.status(406).send({ message: "Username already exists" });
        } else {
            await Staff.update(user, database_id);
            const [updatedUser] = await Staff.getById(
                user.user_id,
                database_id
            );

            res.status(201).send(updatedUser);
        }
    } catch (error) {
        next(error);
    }
};

// delete staff
exports.deleteStaff = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { database_id } = req.user;
        await Staff.delete(id, database_id);
        res.status(201).send({ message: "User deleted successfully!" });
    } catch (error) {
        next(error);
    }
};
