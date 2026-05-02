const pool = require("../config/database");
const bcrypt = require("bcryptjs");

class SystemSecret {
    /**
     * Get a secret by its name
     * @param {string} secret_name 
     * @returns {Promise<Object|null>}
     */
    static async getByName(secret_name) {
        const [rows] = await pool.query(
            "SELECT * FROM system_secrets WHERE secret_name = ?",
            [secret_name]
        );
        return rows.length > 0 ? rows[0] : null;
    }

    /**
     * Verify if the provided password matches the stored hash for a given secret
     * @param {string} secret_name 
     * @param {string} password 
     * @returns {Promise<boolean>}
     */
    static async verifySecret(secret_name, password) {
        const secret = await this.getByName(secret_name);
        if (!secret) return false;

        return await bcrypt.compare(password, secret.secret_hash);
    }

    /**
     * Update a secret's hash
     * @param {string} secret_name 
     * @param {string} new_password 
     * @returns {Promise<void>}
     */
    static async updateSecret(secret_name, new_password) {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(new_password, salt);

        // We use ON DUPLICATE KEY UPDATE or check if exists to be safe
        // But per requirements, it should exist. However, let's make it robust.
        const secret = await this.getByName(secret_name);
        if (secret) {
            await pool.query(
                "UPDATE system_secrets SET secret_hash = ? WHERE secret_name = ?",
                [hash, secret_name]
            );
        } else {
            // Optional: Auto-create if not exists, though user might prefer manual setup
            await pool.query(
                "INSERT INTO system_secrets (secret_name, secret_hash) VALUES (?, ?)",
                [secret_name, hash]
            );
        }
    }
}

module.exports = SystemSecret;
