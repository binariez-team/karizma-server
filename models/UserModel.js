const pool = require("../config/database");
const bcrypt = require("bcryptjs");

class User {
  // get all users except admin
  static async getAll() {
    const [rows] = await pool.query(
      `SELECT user_id, username, first_name, last_name, view_stock, view_reports, delete_invoice, modify_customers FROM users WHERE user_type = 'user' AND is_deleted = 0`
    );
    return rows;
  }

  // get by id
  static async getById(id) {
    const [rows] = await pool.query(
      `SELECT user_id, username, first_name, last_name, view_stock, view_reports, delete_invoice, modify_customers FROM users WHERE user_id = ?`,
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
      `SELECT * FROM users WHERE username = ? AND is_deleted = 0`,
      [username]
    );
    if (!rows) return null;
    const verified = bcrypt.compareSync(password, rows.password);
    return verified ? rows : null;
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
    user.password = bcrypt.hashSync(password, 10);
    const [rows] = await pool.query(`INSERT INTO users SET ?`, user);
    return rows;
  }

  // update user
  static async update(user) {
    await pool.query(`UPDATE users SET ? WHERE user_id = ?`, [
      user,
      user.user_id,
    ]);
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
    await pool.query(`UPDATE users SET is_deleted = 1 WHERE user_id = ?`, id);
  }
}

module.exports = User;
