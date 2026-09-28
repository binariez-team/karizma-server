const Staff = require("../models/StaffModel");
const User = require("../models/UserModel");

// The columns a user may set on their own staff — exactly what the staff form edits.
// Staff rows live in `users` and are written with `SET ?`, so passing req.body through
// would let the caller set anything on the row: user_type (promote to admin),
// database_id (move into another tenant), or permissions that are not the user's to
// hand out, such as edit_stock — which would defeat requirePermission entirely.
const STAFF_FIELDS = [
    "username",
    "password",
    "first_name",
    "last_name",
    "view_purchases",
    "view_stock",
    "edit_invoice",
    "view_reports",
    "deliver_items",
    "view_expenses",
    "view_cash",
    "view_cost",
];
const pickStaffFields = (body) =>
    Object.fromEntries(
        STAFF_FIELDS.filter((key) => key in body).map((key) => [key, body[key]]),
    );

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
        let staff = pickStaffFields(req.body);

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
        let user = pickStaffFields(req.body);
        delete user.password;
        user.user_id = req.body.user_id;
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
