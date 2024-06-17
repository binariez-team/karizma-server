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

const path = require("path");

const { auth, admin } = require("./middleware/auth");
const errorHandler = require("./middleware/errorHandler");

//import routes
const AuthRoutes = require("./routes/auth.routes");
const UsersRoutes = require("./routes/users.routes");
const CustomersRoutes = require("./routes/customers.routes");
const SuppliersRoutes = require("./routes/suppliers.routes");
const AdminStockRoutes = require("./routes/admin-stock.routes");
const UserStockRoutes = require("./routes/user-stock.routes");
const ProfileRoutes = require("./routes/profile.routes");

app.use((req, res, next) => {
	req.io = io;
	next();
});

// routes
app.use("/api/auth", AuthRoutes);
app.use("/api/customers", auth, CustomersRoutes);
app.use("/api/user-stock", auth, UserStockRoutes);
app.use("/api/profile", auth, ProfileRoutes);

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
