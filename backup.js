require('dotenv').config();
const cron = require('node-cron');
const mysqldump = require('mysqldump');
const path = require('path');

// Backup function
function backupDatabase() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/T/, '-').replace(/:/g, '-').replace(/\..+/, '');
    const outputPath = path.join(__dirname, 'backups', `backup-${timestamp}.sql`);

    console.log(`Backup started at: ${timestamp}`);

    mysqldump({
        connection: {
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
        },
        dumpToFile: outputPath,
    }).then(() => {
        console.log(`Backup completed: ${outputPath}`);
    }).catch(err => {
        console.error("Backup failed:", err);
    });
}

// Ensure backups folder exists
const fs = require('fs');
const backupsFolder = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsFolder)) fs.mkdirSync(backupsFolder);

// 🔹 Run twice per day → 4:00 PM & 12:00 AM (Beirut Time)
cron.schedule('0 0,16 * * *', () => {
    console.log("Running scheduled backup...");
    backupDatabase();
}, {
    timezone: "Asia/Beirut"
});

console.log("Cron job scheduled successfully!");
