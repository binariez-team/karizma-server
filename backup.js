require('dotenv').config();
const cron = require('node-cron');
const mysqldump = require('mysqldump');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { google } = require('googleapis');

// Prepare backup directory
const backupsFolder = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsFolder)) fs.mkdirSync(backupsFolder);

// Google Drive Auth - Service Account
const auth = new google.auth.GoogleAuth({
    credentials: {
        private_key: process.env.GOOGLE_SERVICE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_SERVICE_CLIENT_EMAIL,
    },
    scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });

// Upload file to Google Drive
async function uploadToDrive(filePath, fileName) {
    const fileMetadata = {
        name: fileName,
        parents: process.env.DRIVE_FOLDER_ID ? [process.env.DRIVE_FOLDER_ID] : []
    };

    const media = {
        body: fs.createReadStream(filePath)
    };

    try {
        const res = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id'
        });
        console.log(`☁️ Uploaded to Google Drive → File ID: ${res.data.id}`);
    } catch (error) {
        console.error('❌ Google Drive Upload Error:', error.message);
    }
}

// Backup DB then compress & upload
async function backupDatabase() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/T/, '-').replace(/:/g, '-').replace(/\..+/, '');
    const sqlFileName = `backup-${timestamp}.sql`;
    const sqlFilePath = path.join(backupsFolder, sqlFileName);
    const zipFileName = `${sqlFileName}.gz`;
    const zipFilePath = `${sqlFilePath}.gz`;

    console.log(`📀 Backup started: ${timestamp}`);

    try {
        await mysqldump({
            connection: {
                host: process.env.DB_HOST,
                user: process.env.DB_USER,
                password: process.env.DB_PASS,
                database: process.env.DB_NAME,
            },
            dumpToFile: sqlFilePath
        });

        console.log(`✔ SQL backup saved: ${sqlFilePath}`);

        // GZIP compression
        const gzip = zlib.createGzip();
        const source = fs.createReadStream(sqlFilePath);
        const destination = fs.createWriteStream(zipFilePath);

        source.pipe(gzip).pipe(destination).on('finish', async () => {
            console.log(`🗜 Compressed backup created: ${zipFilePath}`);

            // Remove original .sql after compress
            fs.unlinkSync(sqlFilePath);

            await uploadToDrive(zipFilePath, zipFileName);
        });

    } catch (err) {
        console.error("❌ Backup failed:", err.message);
    }
}

// Initialize cron + immediate first backup
function initBackupCron() {
    console.log("🔁 Initializing backup cron...");

    // Backup immediately when server starts
    backupDatabase();

    // Schedule backups → 12:00 AM & 4:00 PM (Asia/Beirut)
    cron.schedule('0 0,16 * * *', () => {
        console.log("⏱ Running scheduled backup job...");
        backupDatabase();
    }, {
        timezone: "Asia/Beirut"
    });

    console.log("🕒 Scheduled backup jobs active!");
}

module.exports = initBackupCron;
