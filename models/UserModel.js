const pool = require("../config/database");
const bcrypt = require("bcryptjs");

class User {
    // get all users except admin
    static async getAll() {
        const [rows] = await pool.query(
            `SELECT * FROM users WHERE user_type = 'user' AND is_deleted = 0`
        );
        return rows;
    }

    // get all exept user id for users
    static async getAllByUser(id) {
        const [rows] = await pool.query(
            `SELECT ud.database_id, ud.database_name FROM user_database ud INNER JOIN users u ON ud.database_id = u.database_id WHERE u.user_type = 'user' AND u.is_deleted = 0 AND u.user_id != ?`,
            [id]
        );
        return rows;
    }

    // get user_databases
    static async getUserDatabases(database_id) {
        const [rows] = await pool.query(
            `SELECT database_id, database_name FROM user_database WHERE database_id != ?`,
            database_id
        );
        return rows;
    }

    // get by id
    static async getById(id) {
        const [rows] = await pool.query(
            `SELECT user_id, username, first_name, last_name, user_type, last_login FROM users WHERE user_id = ?`,
            id
        );
        return rows;
    }

    // validate by username
    static async getByUsername(username) {
        const [rows] = await pool.query(
            `SELECT username FROM users WHERE username = ? AND is_deleted = 0`,
            username
        );
        return rows;
    }

    // validate by id and username
    static async getByIdAndUsername(id, username) {
        const [rows] = await pool.query(
            `SELECT username FROM users WHERE user_id != ?  AND username = ? AND is_deleted = 0`,
            [id, username]
        );
        return rows;
    }

    // validate by username and password
    static async getByUsernameAndPassword(username, password) {
        const [[rows]] = await pool.query(
            `SELECT u.*, d.database_id, d.database_name FROM users u INNER JOIN user_database d ON u.database_id = d.database_id WHERE u.username = ? AND u.is_deleted = 0`,
            [username]
        );

        if (!rows) return null;

        const verified = bcrypt.compareSync(password, rows.password);

        if (!verified) return null;

        // update last login
        await pool.query(
            `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE username = ?`,
            username
        );
        return rows;
    }

    // validate password by user_id
    static async getByPassword(id) {
        const [rows] = await pool.query(
            `SELECT password FROM users WHERE user_id = ?`,
            id
        );
        return rows;
    }

    // create user
    static async create(user) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // create database
            const [record] = await connection.query(
                `INSERT INTO user_database (database_name) VALUES (?)`,
                [user.username]
            );

            delete user.confirm_password;

            user.database_id = record.insertId;

            user.password = bcrypt.hashSync(user.password, 10);

            const [rows] = await connection.query(
                `INSERT INTO users SET ?`,
                user
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

    // update user
    static async update(user) {
        await pool.query(`UPDATE users SET ? WHERE user_id = ?`, [
            user,
            user.user_id,
        ]);

        console.log(user);

        await pool.query(
            `UPDATE user_database SET database_name = ? WHERE database_id = ?`,
            [user.username, user.database_id]
        );
    }

    // update password
    static async updatePassword(user_id, password) {
        const hashed_password = bcrypt.hashSync(password, 10);
        await pool.query(`UPDATE users SET password = ? WHERE user_id = ?`, [
            hashed_password,
            user_id,
        ]);
    }

    // delete user
    static async delete(id) {
        await pool.query(
            `UPDATE users SET is_deleted = 1 WHERE user_id = ?`,
            id
        );
    }
}

module.exports = User;
