require("dotenv").config();
const cron = require("node-cron");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
const db = require("./config/database");

// Prepare exports directory
const exportsFolder = path.join(__dirname, "exports");
if (!fs.existsSync(exportsFolder)) fs.mkdirSync(exportsFolder);

// Google Drive Auth - OAuth2 Refresh Token
const oAuth2Client = new google.auth.OAuth2(
    process.env.OAUTH_CLIENT_ID,
    process.env.OAUTH_CLIENT_SECRET,
);
oAuth2Client.setCredentials({ refresh_token: process.env.OAUTH_REFRESH_TOKEN });

const drive = google.drive({ version: "v3", auth: oAuth2Client });

// Convert date to Beirut timezone correctly
function beirutDate() {
    return new Date().toLocaleString("en-US", { timeZone: "Asia/Beirut" });
}

// Generate file timestamp - YYYY_MM_DD_HH_MM_SS
function timestamp() {
    const date = new Date(beirutDate());
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");

    return `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
}

// ☁ Upload to Google Drive
async function uploadToDrive(filePath, fileName) {
    try {
        const res = await drive.files.create({
            resource: {
                name: fileName,
                parents: [process.env.DRIVE_FOLDER_ID],
            },
            media: { body: fs.createReadStream(filePath) },
            fields: "id, createdTime",
        });
        console.log(`☁️ Uploaded CSV to Drive: ${fileName}`);
        return res.data.id;
    } catch (error) {
        console.error("❌ Drive Upload Error:", error.message);
    }
}

// Helper to escape CSV values
function escapeCSV(val) {
    if (val === null || val === undefined) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('\"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// 🧹 Cleanup Drive exports (keep only last 10)
async function cleanupDriveExports() {
    try {
        const list = await drive.files.list({
            q: `'${process.env.DRIVE_FOLDER_ID}' in parents and trashed = false and name contains 'customers_balances_'`,
            fields: "files(id, name, createdTime)",
        });

        const files = list.data.files || [];
        // Sort by createdTime descending (newest first)
        files.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

        if (files.length > 10) {
            const filesToDelete = files.slice(10); // Keep first 10
            for (const f of filesToDelete) {
                await drive.files.delete({ fileId: f.id });
                console.log(`☁️🗑 Removed old Drive export: ${f.name}`);
            }
        }
    } catch (err) {
        console.error("❌ Drive Cleanup Error:", err.message);
    }
}

async function exportCustomersBalances() {
    const time = timestamp();
    const fileName = `customers_balances_${time}.csv`;
    const filePath = path.join(exportsFolder, fileName);

    console.log(`📊 Export started: ${time}`);

    try {
        const query = `
            SELECT a.account_id, a.name, a.phone, ud.database_name, COALESCE(SUM(ji.debit) - SUM(ji.credit), 0) AS balance
            FROM journal_items ji
            LEFT JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
            LEFT JOIN user_database ud ON ji.database_id = ud.database_id
            INNER JOIN accounts a ON ji.partner_id_fk = a.account_id
            WHERE ji.is_deleted = 0
            AND a.is_customer = 1
            AND a.is_deleted = 0
            GROUP BY a.account_id, a.name, a.phone, ud.database_name
            HAVING balance != 0
            ORDER BY balance DESC;
        `;

        const [rows] = await db.query(query);

        // Build CSV
        let csvContent = "account_id,name,phone,database_name,balance\n";

        for (const row of rows) {
            const rowData = [
                escapeCSV(row.account_id),
                escapeCSV(row.name),
                escapeCSV(row.phone),
                escapeCSV(row.database_name),
                escapeCSV(row.balance),
            ];
            csvContent += rowData.join(",") + "\n";
        }

        fs.writeFileSync(filePath, csvContent, "utf8");
        console.log(`✔ CSV saved locally: ${fileName}`);

        await uploadToDrive(filePath, fileName);

        await cleanupDriveExports();

        // Clean up locally after upload
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑 Removed local CSV: ${fileName}`);
        }
    } catch (err) {
        console.error("❌ Export failed:", err.message);
    }
}

function initExportCron() {
    console.log("🔁 Initializing export customers balances cron...");

    // Run once at startup
    exportCustomersBalances();

    // Schedule → every 1 hour (runs at minute 0 past every hour)
    cron.schedule("0 * * * *", exportCustomersBalances, {
        timezone: "Asia/Beirut",
    });

    console.log("🕒 Scheduled export job active ✔");
}

module.exports = initExportCron;
