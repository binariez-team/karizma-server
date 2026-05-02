require("dotenv").config();
const pool = require("./config/database");
const bcrypt = require("bcryptjs");

async function seed() {
    console.log("Starting database seeding...");

    try {
        // 1. Ensure table exists (in case it wasn't created yet)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS system_secrets (
                secret_id int NOT NULL AUTO_INCREMENT,
                secret_name varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
                secret_hash varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
                PRIMARY KEY (secret_id),
                UNIQUE KEY (secret_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
        `);
        console.log("- Table 'system_secrets' ensured.");

        // 2. Define the default password
        const secretName = "reports_password";
        const defaultPassword = "admin";
        
        // 3. Hash the password
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(defaultPassword, salt);

        // 4. Check if it already exists
        const [rows] = await pool.query(
            "SELECT * FROM system_secrets WHERE secret_name = ?",
            [secretName]
        );

        if (rows.length === 0) {
            // Insert if not exists
            await pool.query(
                "INSERT INTO system_secrets (secret_name, secret_hash) VALUES (?, ?)",
                [secretName, hash]
            );
            console.log(`- Created default secret: '${secretName}' with password 'admin'`);
        } else {
            // Update if already exists (to reset to default if needed)
            await pool.query(
                "UPDATE system_secrets SET secret_hash = ? WHERE secret_name = ?",
                [hash, secretName]
            );
            console.log(`- Updated existing secret: '${secretName}' to password 'admin'`);
        }

        console.log("Seeding completed successfully!");
    } catch (error) {
        console.error("Seeding failed:", error);
    } finally {
        // Close the pool to exit the script
        await pool.end();
        process.exit();
    }
}

seed();
