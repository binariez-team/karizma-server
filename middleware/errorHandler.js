const fs = require("fs");
const path = require("path");

// Function to ensure the error directory exists
const ensureErrorDirectoryExists = (directory) => {
	if (!fs.existsSync(directory)) {
		fs.mkdirSync(directory, { recursive: true });
	}
};

const errorHandler = (err, req, res, next) => {
	console.log(err);

	const errorDirectory = path.join(__dirname, "../errors");
	ensureErrorDirectoryExists(errorDirectory);

	const errorLogPath = path.join(errorDirectory, "error.log");

	if (!fs.existsSync("../errors")) {
		console.log("called");
		fs.mkdirSync("../errors", { recursive: true }); // Create directory if it doesn't exist
		fs.writeFileSync(logFilePath);
	}

	const timestamp = new Date().toISOString();
	const logMessage = `${timestamp} [ERROR]: ${err}\n`;
	fs.appendFile(errorLogPath, logMessage, (err) => {
		if (err) {
			console.error("Failed to write to log file:", err);
		}
	});

	res.status(500).json({ error: "Internal Server Error" });
};

module.exports = errorHandler;
