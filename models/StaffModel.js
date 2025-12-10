const pool = require("../config/database");
const bcrypt = require("bcryptjs");

class Staff {
    // get all staff for the specified database_id
    static async getAll(database_id) {
        const query = `SELECT * FROM users WHERE user_type = 'staff' AND is_deleted = 0 AND database_id = ?`;
        const [rows] = await pool.query(query, [database_id]);
        return rows;
    }

    // get by id
    static async getById(id, database_id) {
        const query = `SELECT * FROM users WHERE user_id = ? AND database_id = ?`;
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

    // update
    static async update(staff, database_id) {
        const query = `UPDATE users SET ? WHERE user_id = ? AND database_id = ?`;
        await pool.query(query, [staff, staff.user_id, database_id]);
    }

    // delete
    static async delete(id, database_id) {
        const query = `UPDATE users SET is_deleted = 1 WHERE user_id = ? AND database_id = ?`;
        await pool.query(query, [id, database_id]);
    }
}

module.exports = Staff;
