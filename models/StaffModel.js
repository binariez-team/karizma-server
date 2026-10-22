const pool = require("../config/database");
const bcrypt = require("bcryptjs");

// The columns the staff screen shows and edits — never the password hash (or anything
// else on the users row the screen has no use for).
const STAFF_COLUMNS = `user_id, username, first_name, last_name, last_login, view_purchases, view_stock, edit_invoice, view_reports, deliver_items, view_expenses, view_cash, view_cost`;

class Staff {
    // get all staff for the specified database_id
    static async getAll(database_id) {
        const query = `SELECT ${STAFF_COLUMNS} FROM users WHERE user_type = 'staff' AND is_deleted = 0 AND database_id = ?`;
        const [rows] = await pool.query(query, [database_id]);
        return rows;
    }

    // get by id — staff rows only, so the owner's row (or another login) is never read
    // back through this route
    static async getById(id, database_id) {
        const query = `SELECT ${STAFF_COLUMNS} FROM users WHERE user_id = ? AND database_id = ? AND user_type = 'staff'`;
        const [rows] = await pool.query(query, [id, database_id]);
        return rows;
    }

    // create
    static async create(staff, database_id) {
        staff.database_id = database_id;
        staff.user_type = "staff";
        staff.password = bcrypt.hashSync(staff.password, 10);
        const query = `INSERT INTO users SET ?`;
        const [rows] = await pool.query(query, [staff]);
        return rows;
    }

    // update — returns whether a staff row was found (mysql2 counts matched rows, so a
    // save that changes nothing still counts)
    static async update(staff, database_id, caller_id) {
        // user_type = 'staff': a user shares database_id with their staff, so without
        // it the owner's own row is reachable through this route too. user_id != caller:
        // the caller never edits their own row here, whatever its type.
        const query = `UPDATE users SET ? WHERE user_id = ? AND database_id = ? AND user_type = 'staff' AND user_id != ?`;
        const [result] = await pool.query(query, [
            staff,
            staff.user_id,
            database_id,
            caller_id,
        ]);
        return result.affectedRows > 0;
    }

    // delete — returns whether a staff row was found. Same guards as update: without
    // them any login of the database, the owner included, could be soft-deleted.
    static async delete(id, database_id, caller_id) {
        const query = `UPDATE users SET is_deleted = 1 WHERE user_id = ? AND database_id = ? AND user_type = 'staff' AND user_id != ?`;
        const [result] = await pool.query(query, [id, database_id, caller_id]);
        return result.affectedRows > 0;
    }
}

module.exports = Staff;
