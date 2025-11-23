require('dotenv').config();
const cron = require('node-cron');
const mysqldump = require('mysqldump');
const path = require('path');
const fs = require('fs');

// Ensure backups folder exists
const backupsFolder = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsFolder)) fs.mkdirSync(backupsFolder);

// Backup function
function backupDatabase() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/T/, '-').replace(/:/g, '-').replace(/\..+/, '');
    const outputPath = path.join(backupsFolder, `backup-${timestamp}.sql`);

    console.log(`📀 Backup started: ${timestamp}`);

    mysqldump({
        connection: {
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
        },
        dumpToFile: outputPath,
    }).then(() => {
        console.log(`✅ Backup completed: ${outputPath}`);
    }).catch(err => {
        console.error("❌ Backup failed:", err.message);
    });
}


// Start cron + immediate first backup
function initBackupCron() {
    console.log("💡 Backup cron initializing...");

    // 🔹 Immediate backup when server starts
    backupDatabase();

    // 🔹 Scheduled backups: 12 AM + 4 PM Beirut time
    cron.schedule('0 0,16 * * *', () => {
        console.log("⏱ Running scheduled backup job...");
        backupDatabase();
    }, {
        timezone: "Asia/Beirut"
    });

    console.log("⏳ Scheduled backup jobs set!");
}

module.exports = initBackupCron;
