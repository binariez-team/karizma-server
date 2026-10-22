const Staff = require("../models/StaffModel");
const User = require("../models/UserModel");

// The columns a user may set on their own staff — exactly what the staff form edits.
// Staff rows live in `users` and are written with `SET ?`, so passing req.body through
// would let the caller set anything on the row: user_type (promote to admin),
// database_id (move into another tenant), or permissions that are not the user's to
// hand out, such as edit_stock or correct_debt — which would defeat requirePermission
// entirely.
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

// mysql2 also expands an object bound to `?` into `key = value` SQL (and an array into
// a list), so each picked field must be a plain value: the staff form sends strings,
// null for empty names and 0/1 or true/false from the permission switches.
const isPlain = (value) =>
    value === null || ["string", "number", "boolean"].includes(typeof value);
const INVALID_STAFF = { message: "Invalid staff" };

// One answer for a missing id, another database's login, the owner's own row or any
// other non-staff login, so ids cannot be probed.
const STAFF_NOT_FOUND = { message: "Staff not found" };

// Ids come from the URL or the JSON body; only a positive integer reaches the queries.
const toId = (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

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
        if (!Object.values(staff).every(isPlain)) {
            return res.status(400).send(INVALID_STAFF);
        }

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
        const { database_id, user_id: caller_id } = req.user;
        let user = pickStaffFields(req.body);
        delete user.password;
        if (!Object.values(user).every(isPlain)) {
            return res.status(400).send(INVALID_STAFF);
        }
        user.user_id = toId(req.body.user_id);
        if (!user.user_id) {
            return res.status(404).send(STAFF_NOT_FOUND);
        }
        let [validateUser] = await User.getByIdAndUsername(
            user.user_id,
            user.username
        );
        if (validateUser) {
            res.status(406).send({ message: "Username already exists" });
        } else {
            const updated = await Staff.update(user, database_id, caller_id);
            if (!updated) {
                return res.status(404).send(STAFF_NOT_FOUND);
            }
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
        const id = toId(req.params.id);
        const { database_id, user_id: caller_id } = req.user;
        const deleted = id && (await Staff.delete(id, database_id, caller_id));
        if (!deleted) {
            return res.status(404).send(STAFF_NOT_FOUND);
        }
        res.status(201).send({ message: "User deleted successfully!" });
    } catch (error) {
        next(error);
    }
};
