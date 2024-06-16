const fs = require("fs");
const path = require("path");

const logFilePath = path.join(__dirname, "..", "error.log");

const errorHandler = (err, req, res, next) => {
	console.error(err);

	const timestamp = new Date().toISOString();
	const logMessage = `${timestamp} [ERROR]: ${err}\n`;
	fs.appendFile(logFilePath, logMessage, (err) => {
		if (err) {
			console.error("Failed to write to log file:", err);
		}
	});

	res.status(500).json({ error: "Internal Server Error" });
};

module.exports = errorHandler;
