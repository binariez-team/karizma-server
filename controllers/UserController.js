const User = require("../models/UserModel");

// users.edit_stock / users.correct_debt are TINYINT(1) NOT NULL DEFAULT 0. The dialog
// sends a boolean; a null (e.g. from a client built before the toggle existed) would
// fail the write under STRICT_TRANS_TABLES, so coerce whatever arrives to 0/1.
const normalizePermissions = (user) => {
    if ("edit_stock" in user) user.edit_stock = user.edit_stock ? 1 : 0;
    if ("correct_debt" in user) user.correct_debt = user.correct_debt ? 1 : 0;
};

// The user's profit share (D3) and assets cap (D6) live on his tenant row
// (user_database), not on users, so they are taken OUT of the body before
// `users SET ?` (an unknown column would fail the write) and written by UserModel with
// fixed SQL. Only keys present in the body are written: a client built before the
// fields existed leaves both values untouched. A present assets_cap_usd: null clears
// the cap.
const DECIMAL_2 = /^\d+(\.\d{1,2})?$/;
const PCT_MESSAGE = "Profit share must be between 0 and 100, with at most 2 decimals.";
const CAP_MESSAGE =
    "Assets cap must be empty or an amount from 0 to 9,999,999,999.99, with at most 2 decimals.";

// A JS number or a digit string with at most 2 decimals, from 0 to max; else null
const amount = (value, max) => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    const text = String(value);
    if (!DECIMAL_2.test(text)) return null;
    const n = Number(text);
    return n <= max ? n : null;
};

/**
 * Validate and remove profit_share_pct / assets_cap_usd from the request body.
 * @returns {{ settings: { profit_share_pct?: number, assets_cap_usd?: number|null } }
 *   | { error: string }}  on error the body is left as it was
 */
const takeTenantSettings = (body) => {
    const settings = {};
    if ("profit_share_pct" in body) {
        const pct = amount(body.profit_share_pct, 100);
        if (pct === null) return { error: PCT_MESSAGE };
        settings.profit_share_pct = pct;
    }
    if ("assets_cap_usd" in body) {
        const raw = body.assets_cap_usd;
        const cap = raw === null ? null : amount(raw, 9999999999.99);
        if (raw !== null && cap === null) return { error: CAP_MESSAGE };
        settings.assets_cap_usd = cap;
    }
    delete body.profit_share_pct;
    delete body.assets_cap_usd;
    return { settings };
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
        // checked before any query, the username check included
        const tenant = takeTenantSettings(user);
        if (tenant.error) return res.status(400).send({ message: tenant.error });

        // validate if username already taken
        let [validateUser] = await User.getByUsername(user.username);
        if (validateUser) {
            res.status(406).send({ message: "Username already exists" });
        } else {
            // create user
            normalizePermissions(user);
            let result = await User.create(user, tenant.settings);
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
        // checked before any query, the username check included
        const tenant = takeTenantSettings(user);
        if (tenant.error) return res.status(400).send({ message: tenant.error });

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
            await User.update(user, tenant.settings);
            const [updatedUser] = await User.getForAdmin(user.user_id);
            res.status(201).send(updatedUser);
        }
    } catch (error) {
        next(error);
    }
};

// Only a whole positive number reaches the queries (the Users screen sends the row's
// numeric user_id); anything else matches no login
const toId = (value) => {
    const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// delete user (and, when he was his shop's last owner, the shop's staff: User.delete)
exports.deleteUser = async (req, res, next) => {
    const id = toId(req.params.id);
    try {
        if (!id) return res.status(404).send({ message: "User not found" });
        await User.delete(id);
        res.status(201).send({ message: "User deleted successfully!" });
    } catch (error) {
        next(error);
    }
};
