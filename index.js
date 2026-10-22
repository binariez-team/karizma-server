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

const { auth, admin, owner } = require("./middleware/auth");
const reportsAccess = require("./middleware/reportsAccess");
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
const ReportsV2Routes = require("./routes/reports-v2.routes");
const ReturnRoutes = require("./routes/return.routes");
const PurchaseRoutes = require("./routes/purchase-orders.routes");

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
// reports v2: the reports password gate (users and staff) runs after the login check
app.use("/reports/v2", auth, reportsAccess, ReportsV2Routes);
app.use("/return", auth, ReturnRoutes);
app.use("/dispose", auth, require("./routes/dispose.routes"));
// staff management: the account owner (admin or user) manages their own staff; staff
// share the owner's database_id, so without `owner` they could edit their own
// permissions, create logins or delete the owner
app.use("/staff", auth, owner, require("./routes/staff.routes"));
app.use("/transfer", auth, require("./routes/transfer.routes"));
// partner shares taken (reports v2 Phase 7.1): users record, the admin approves; the
// router refuses staff (`owner`) and re-reads the live login on every route
app.use("/partner-shares", auth, require("./routes/partner-shares.routes"));
app.use("/deliver", auth, DeliverRoutes);
app.use("/quotations", auth, require("./routes/quotations.routes"));

// admin routes
app.use("/admin-stock", admin, AdminStockRoutes);
app.use("/users", admin, UsersRoutes);
app.use("/suppliers", admin, SuppliersRoutes);
app.use("/purchase", admin, PurchaseRoutes);
app.use("/admin-history", admin, AdminHistoryRoutes);

// user routes
app.use("/user-history", auth, UserHistoryRoutes);
app.use("/user-stock", auth, UserStockRoutes);
app.use("/user-deliver", auth, require("./routes/user-deliver.routes"));

// check API status page
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// handle errors
app.use(errorHandler);

const initBackupCron = require("./backup"); // Import cron module
const initExportCron = require("./export-customers-balances"); // Import export cron module
const initInventorySnapshotCron = require("./jobs/inventorySnapshot"); // Month-end stock snapshot

initBackupCron(); // Initialize the backup cron job
initExportCron(); // Initialize export cron job
initInventorySnapshotCron(); // Month-end stock snapshot (not run at startup)

// start server
server.listen(process.env.PORT, () =>
    console.log(`listening on port ${process.env.PORT} ...`),
);
