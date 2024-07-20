require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

// allow Cross-Origin calls to this app
const cors = require("cors");
app.use(cors());

// create server for socket.io
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
const DeliverRoutes = require("./routes/deliver.routes");
const SellOrdersRoutes = require("./routes/sell-orders.routes");
const HistoryRoutes = require("./routes/history.routes");
const AdminHistoryRoutes = require("./routes/admin-history.routes");
const UserHistoryRoutes = require("./routes/user-history.routes");
const PaymentRoutes = require("./routes/payment.routes");
const BalanceRoutes = require("./routes/balance.routes");
const ExpenseRoutes = require("./routes/expense.routes");
const ReportRoutes = require("./routes/report.routes");

app.use((req, res, next) => {
	req.io = io;
	next();
});

// common routes
app.use("/auth", AuthRoutes);
app.use("/customers", auth, CustomersRoutes);
app.use("/profile", auth, ProfileRoutes);
app.use("/sell-orders", auth, SellOrdersRoutes);
app.use("/history", auth, HistoryRoutes);
app.use("/payment", auth, PaymentRoutes);
app.use("/balance", auth, BalanceRoutes);
app.use("/expense", auth, ExpenseRoutes);
app.use("/report", auth, ReportRoutes);

// admin routes
app.use("/admin-stock", admin, AdminStockRoutes);
app.use("/users", admin, UsersRoutes);
app.use("/suppliers", admin, SuppliersRoutes);
app.use("/deliver", admin, DeliverRoutes);
app.use("/admin-history", admin, AdminHistoryRoutes);

// user routes
app.use("/user-history", auth, UserHistoryRoutes);
app.use("/user-stock", auth, UserStockRoutes);

// check API status page
app.get("/", (req, res) => {
	res.sendFile(path.join(__dirname, "public", "index.html"));
});

// handle errors
app.use(errorHandler);

// server.listen(3500, () => console.log(`listening on port 3500 ...`));
module.exports = server;
