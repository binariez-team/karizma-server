require('dotenv').config();
const cron = require('node-cron');
const mysqldump = require('mysqldump');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { google } = require('googleapis');

const BACKUP_RETENTION_DAYS = process.env.BACKUP_RETENTION_DAYS;
const BACKUP_NAME = process.env.BACKUP_NAME;

// Prepare backup directory
const backupsFolder = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsFolder)) fs.mkdirSync(backupsFolder);

// Google Drive Auth - OAuth2 Refresh Token
const oAuth2Client = new google.auth.OAuth2(
    process.env.OAUTH_CLIENT_ID,
    process.env.OAUTH_CLIENT_SECRET
);
oAuth2Client.setCredentials({ refresh_token: process.env.OAUTH_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oAuth2Client });

// 🕒 Generate Beirut timestamp (AM/PM, safe for filename)
// function timestamp() {
//     return new Date()
//         .toLocaleString('en-US', { timeZone: 'Asia/Beirut', hour12: true })
//         .replace(/\//g, '-') 
//         .replace(/:/g, '-')
//         .replace(/,/g, '')
//         .replace(/ /g, '_');
// }

// Convert date to Beirut timezone correctly
function beirutDate() {
    return new Date().toLocaleString("en-US", { timeZone: "Asia/Beirut" });
}

// Generate file timestamp - YYYY-MM-DD_HH-MM-SS_AM
function timestamp() {
    const date = new Date(beirutDate());
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");

    // const ampm = hours >= 12 ? "PM" : "AM";
    // hours = hours % 12 || 12;
    // hours = String(hours).padStart(2, "0");

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ☁ Upload to Google Drive
async function uploadToDrive(filePath, fileName) {
    try {
        const res = await drive.files.create({
            resource: {
                name: fileName,
                parents: [process.env.DRIVE_FOLDER_ID]
            },
            media: { body: fs.createReadStream(filePath) },
            fields: 'id, createdTime'
        });
        console.log(`☁️ Uploaded to Drive: ${fileName}`);
        return res.data.id;
    } catch (error) {
        console.error("❌ Drive Upload Error:", error.message);
    }
}

// 🧹 Cleanup Local Backups
function cleanupLocalBackups() {
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    fs.readdirSync(backupsFolder).forEach(file => {
        const filePath = path.join(backupsFolder, file);
        const stats = fs.statSync(filePath);

        if (stats.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            console.log(`🗑 Removed local old backup: ${file}`);
        }
    });
}

// 🧹 Cleanup Drive backups older than X days
async function cleanupDriveBackups() {
    const cutoffDate = new Date(Date.now() - BACKUP_RETENTION_DAYS * 864e5).toISOString();

    try {
        const list = await drive.files.list({
            q: `'${process.env.DRIVE_FOLDER_ID}' in parents and trashed = false`,
            fields: 'files(id, name, createdTime)'
        });

        for (const f of list.data.files) {
            if (f.createdTime < cutoffDate) {
                await drive.files.delete({ fileId: f.id });
                console.log(`☁️🗑 Removed Drive backup: ${f.name}`);
            }
        }
    } catch (err) {
        console.error("❌ Drive Cleanup Error:", err.message);
    }
}

// 📦 Backup DB → Compress → Upload → Cleanup
async function backupDatabase() {
    const time = timestamp();
    const sqlFile = `${BACKUP_NAME}_${time}.sql`;
    const sqlPath = path.join(backupsFolder, sqlFile);
    const gzFile = `${sqlFile}.gz`;
    const gzPath = `${sqlPath}.gz`;

    console.log(`📀 Backup started: ${time}`);

    try {
        await mysqldump({
            connection: {
                host: process.env.DB_HOST,
                user: process.env.DB_USER,
                password: process.env.DB_PASS,
                database: process.env.DB_NAME,
            },
            dumpToFile: sqlPath
        });

        console.log(`✔ SQL saved locally`);

        const gzip = zlib.createGzip();
        fs.createReadStream(sqlPath)
            .pipe(gzip)
            .pipe(fs.createWriteStream(gzPath))
            .on('finish', async () => {
                console.log(`🗜 Created compressed backup`);

                fs.unlinkSync(sqlPath);

                await uploadToDrive(gzPath, gzFile);

                await cleanupLocalBackups();
                await cleanupDriveBackups();
            });

    } catch (err) {
        console.error("❌ Backup failed:", err.message);
    }
}

// 🎯 Cron init
function initBackupCron() {
    console.log("🔁 Initializing backup cron...");

    // Run once at startup
    backupDatabase();

    // Schedule → 12AM, 12PM, 3PM, 6PM Beirut
    cron.schedule('0 0,12,15,18 * * *', backupDatabase, {
        timezone: "Asia/Beirut"
    });

    console.log("🕒 Scheduled jobs active ✔");
}

module.exports = initBackupCron;
