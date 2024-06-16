require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

const cors = require("cors");
// allow Cross-Origin calls to this app
app.use(cors());

const http = require("http");
const socketIO = require("socket.io");

const server = http.createServer(app); // Create server from Express app

const io = socketIO(server, {
	cors: {
		origins: ["*"],
	},
});

const fs = require("fs");
const path = require("path");

const logFilePath = path.join(__dirname, "errors", "error.log");
io.on("connection", () => {
	console.log("user connected");
	const timestamp = new Date().toISOString();
	const logMessage = `${timestamp} [info]: User connected\n`;
	fs.appendFile(logFilePath, logMessage, (err) => {
		if (err) {
			console.error("Failed to write to log file:", err);
		}
	});
});

io.on("disconnection", () => {
	console.log("user disconnected");
});

const { auth, admin } = require("./middleware/auth");
const errorHandler = require("./middleware/errorHandler");

//import routes
const AuthRoutes = require("./routes/auth.routes");
const UsersRoutes = require("./routes/users.routes");
const CustomersRoutes = require("./routes/customers.routes");
const SuppliersRoutes = require("./routes/suppliers.routes");
const AdminStockRoutes = require("./routes/admin-stock.routes");
const UserStockRoutes = require("./routes/user-stock.routes");

app.use((req, res, next) => {
	req.io = io;
	next();
});

// routes
app.use("/api/auth", AuthRoutes);

app.use("/api/customers", auth, CustomersRoutes);
app.use("/api/user-stock", auth, UserStockRoutes);

//admin routes
app.use("/api/admin-stock", admin, AdminStockRoutes);
app.use("/api/users", admin, UsersRoutes);
app.use("/api/suppliers", admin, SuppliersRoutes);

app.get("/", (req, res) => {
	res.sendFile(path.join(__dirname, "public", "index.html"));
});

// handle errors
app.use(errorHandler);

// server.listen(3500, () => console.log(`listening on port 3500 ...`));
module.exports = server;
