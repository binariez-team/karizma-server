const pool = require("../config/database");
const bcrypt = require("bcryptjs");

// No staff without an owner. A shop (tenant) has an owner while it has an admin login —
// the admin's shop always has one — or a live user login:
//
//     user_type = 'admin' OR (user_type = 'user' AND is_deleted = 0)
//
// Staff of a shop with no owner cannot log in (AuthController.login) or open reports
// (reports-v2/access.loadViewer, same test), and deleting a shop's last owner deletes
// its staff too (User.delete).

// The columns the admin Users screen shows and edits (getAll, getForAdmin), from
// `users u LEFT JOIN user_database d` — never the password hash. Both reads return the
// same columns, so a row from the list and a row the screen gets back after a save are
// alike.
const ADMIN_COLUMNS = `u.user_id, u.username, u.first_name, u.last_name, u.user_type, u.last_login, u.database_id, u.edit_stock, u.correct_debt, d.profit_share_pct, d.assets_cap_usd`;

class User {
    // get all users except admin, with their tenant's profit share and assets cap (raw
    // DECIMAL strings; null when the tenant row is missing)
    static async getAll() {
        const [rows] = await pool.query(
            `SELECT ${ADMIN_COLUMNS} FROM users u LEFT JOIN user_database d ON d.database_id = u.database_id WHERE u.user_type = 'user' AND u.is_deleted = 0`,
        );
        return rows;
    }

    // get by id — the login's own row for ProfileController.updateProfile, which re-signs
    // the token with the same claims as AuthController.login (so database_id is needed)
    // and answers with the same permission flags. Never the password hash.
    static async getById(id) {
        const [rows] = await pool.query(
            `SELECT user_id, username, first_name, last_name, user_type, last_login, database_id, view_purchases, view_stock, edit_invoice, view_reports, deliver_items, view_expenses, view_cash, view_cost, transfer_money, edit_stock, correct_debt FROM users WHERE user_id = ?`,
            id,
        );
        return rows;
    }

    // get by id — the row the admin users screen works with: database_id (a hidden value
    // in the dialog), the permission flags the dialog edits, and the tenant's profit
    // share and assets cap, as in getAll.
    static async getForAdmin(id) {
        const [rows] = await pool.query(
            `SELECT ${ADMIN_COLUMNS} FROM users u LEFT JOIN user_database d ON d.database_id = u.database_id WHERE u.user_id = ?`,
            id,
        );
        return rows;
    }

    // get database by id
    static async getDatabaseById(id) {
        const [rows] = await pool.query(
            `SELECT database_id, database_name FROM user_database WHERE database_id = ?`,
            id,
        );
        return rows;
    }

    // validate by username
    static async getByUsername(username) {
        const [rows] = await pool.query(
            `SELECT username FROM users WHERE username = ? AND is_deleted = 0`,
            username,
        );
        return rows;
    }

    // validate by id and username
    static async getByIdAndUsername(id, username) {
        const [rows] = await pool.query(
            `SELECT username FROM users WHERE user_id != ?  AND username = ? AND is_deleted = 0`,
            [id, username],
        );
        return rows;
    }

    // validate by username and password. The row carries has_owner (EXISTS: 0/1) for
    // User.isOrphanStaff. The password hash is read only to check the password and is
    // removed from the row before it is returned.
    static async getByUsernameAndPassword(username, password) {
        const [[rows]] = await pool.query(
            `SELECT u.*, d.database_id, d.database_name, EXISTS (SELECT 1 FROM users o WHERE o.database_id = u.database_id AND (o.user_type = 'admin' OR (o.user_type = 'user' AND o.is_deleted = 0))) AS has_owner FROM users u INNER JOIN user_database d ON u.database_id = d.database_id WHERE u.username = ? AND u.is_deleted = 0`,
            [username],
        );

        if (!rows) return null;

        const verified = bcrypt.compareSync(password, rows.password);

        if (!verified) return null;

        delete rows.password;

        // The password is right but the login is refused (AuthController.login), so it
        // is not recorded as one
        if (User.isOrphanStaff(rows)) return rows;

        // update last login
        await pool.query(
            `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE username = ?`,
            username,
        );
        return rows;
    }

    // validate password by user_id
    static async getByPassword(id) {
        const [rows] = await pool.query(
            `SELECT password FROM users WHERE user_id = ?`,
            id,
        );
        return rows;
    }

    // create user. `settings` holds the profit share / assets cap the Users form sent
    // (UserController.takeTenantSettings, already validated and removed from `user`).
    static async create(user, settings = {}) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // create database: with the form's settings when it sent any (a missing
            // share is the default 50, a missing cap is no cap), else the column defaults
            const withSettings =
                "profit_share_pct" in settings || "assets_cap_usd" in settings;
            const [record] = withSettings
                ? await connection.query(
                      `INSERT INTO user_database (database_name, profit_share_pct, assets_cap_usd) VALUES (?, ?, ?)`,
                      [
                          user.username,
                          settings.profit_share_pct ?? 50,
                          settings.assets_cap_usd ?? null,
                      ],
                  )
                : await connection.query(
                      `INSERT INTO user_database (database_name) VALUES (?)`,
                      [user.username],
                  );

            delete user.confirm_password;

            user.database_id = record.insertId;

            user.password = bcrypt.hashSync(user.password, 10);

            const [rows] = await connection.query(
                `INSERT INTO users SET ?`,
                user,
            );

            await connection.commit();

            return rows;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // update user. user.database_id is the STORED tenant (UserController.updateUser);
    // `settings` as in create.
    static async update(user, settings = {}) {
        await pool.query(`UPDATE users SET ? WHERE user_id = ?`, [
            user,
            user.user_id,
        ]);

        await pool.query(
            `UPDATE user_database SET database_name = ? WHERE database_id = ?`,
            [user.username, user.database_id],
        );

        // One of three fixed statements, picked by which keys the form sent; nothing
        // from the body becomes SQL. Neither key → no further write.
        const hasPct = "profit_share_pct" in settings;
        const hasCap = "assets_cap_usd" in settings;
        if (hasPct && hasCap) {
            await pool.query(
                `UPDATE user_database SET profit_share_pct = ?, assets_cap_usd = ? WHERE database_id = ?`,
                [settings.profit_share_pct, settings.assets_cap_usd, user.database_id],
            );
        } else if (hasPct) {
            await pool.query(
                `UPDATE user_database SET profit_share_pct = ? WHERE database_id = ?`,
                [settings.profit_share_pct, user.database_id],
            );
        } else if (hasCap) {
            await pool.query(
                `UPDATE user_database SET assets_cap_usd = ? WHERE database_id = ?`,
                [settings.assets_cap_usd, user.database_id],
            );
        }
    }

    // update password
    static async updatePassword(user_id, password) {
        const hashed_password = bcrypt.hashSync(password, 10);
        await pool.query(`UPDATE users SET password = ? WHERE user_id = ?`, [
            hashed_password,
            user_id,
        ]);
    }

    // A staff login whose shop has no owner (the rule at the top); `row` is a
    // getByUsernameAndPassword row
    static isOrphanStaff(row) {
        return row.user_type === "staff" && !Number(row.has_owner);
    }

    // delete user (soft). `id` is a validated whole positive number
    // (UserController.deleteUser). When the login is a user and his shop is left with no
    // owner, the shop's staff are deleted with him, in the same transaction. A shop with
    // an admin login (the admin's) always keeps its owner, so its staff are never
    // touched here, and neither are another live user's.
    static async delete(id) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // Row-locked until commit, so a second delete of this login waits here
            const [[login]] = await connection.query(
                `SELECT user_type, database_id FROM users WHERE user_id = ? FOR UPDATE`,
                [id],
            );

            await connection.query(
                `UPDATE users SET is_deleted = 1 WHERE user_id = ?`,
                [id],
            );

            if (login && login.user_type === "user") {
                // A locking read sees the delete above and the latest committed rows, and
                // holds the owner it finds, so that owner cannot be deleted in parallel
                // while his shop's staff stay
                const [[owner]] = await connection.query(
                    `SELECT user_id FROM users WHERE database_id = ? AND (user_type = 'admin' OR (user_type = 'user' AND is_deleted = 0)) LIMIT 1 FOR UPDATE`,
                    [login.database_id],
                );
                if (!owner) {
                    await connection.query(
                        `UPDATE users SET is_deleted = 1 WHERE database_id = ? AND user_type = 'staff' AND is_deleted = 0`,
                        [login.database_id],
                    );
                }
            }

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = User;
