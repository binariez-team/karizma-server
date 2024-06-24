const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

// Function to ensure the error directory exists
const ensureErrorDirectoryExists = (directory) => {
	if (!fs.existsSync(directory)) {
		fs.mkdirSync(directory, { recursive: true });
	}
};

if (process.env.NODE_ENV === "production") {
	var pool = mysql.createPool({
		connectionLimit: 10,
		host: "66.45.23.20",
		user: "karizmam_app",
		password: ",Yqv(j93q]4w",
		database: "karizmam_karizma",
		multipleStatements: true,
		dateStrings: true,
	});
	pool.on("connection", (connection) => {
		const logDirectory = path.join(__dirname, "../logs");
		ensureLogDirectoryExists(logDirectory);

		const logFilePath = path.join(logDirectory, "logs.log");

		if (!fs.existsSync("../logs")) {
			fs.mkdirSync("../logs", { recursive: true }); // Create directory if it doesn't exist
			fs.writeFileSync(logFilePath);
		}

		const timestamp = new Date().toISOString();
		let logMessage;
		connection.query("SET time_zone = '+03:00'", (error) => {
			if (error) {
				logMessage = `${timestamp} [Error setting timezone:]: ${error}\n`;
				console.error("Error setting timezone:", error);
			} else {
				console.log("Timezone set to +03:00 successfully");
				logMessage = `${timestamp} [Success]: Timezone set to +03:00 successfully\n`;
			}

			fs.appendFile(logFilePath, logMessage, (err) => {
				if (err) {
					console.log("Failed to write to log file:", err);
				}
			});
		});
	});
} else {
	var pool = mysql.createPool({
		connectionLimit: 10,
		host: "localhost",
		user: "root",
		password: "roottoor",
		database: "karizma",
		multipleStatements: true,
		dateStrings: true,
	});
}

pool.getConnection(async (err, connection) => {
	if (err) {
		if (err.code === "PROTOCOL_CONNECTION_LOST") {
			console.error("Database connection was closed.");
		}
		if (err.code === "ER_CON_COUNT_ERROR") {
			console.error("Database has too many connections.");
		}
		if (err.code === "ECONNREFUSED") {
			console.error("Database connection was refused.");
		}
	}
	if (connection) await connection.release();
	return;
});

module.exports = pool;
