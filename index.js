const app = require("./app");
const cors = require("cors");
const { auth, admin } = require("./middleware/auth");
const errorHandler = require("./middleware/errorHandler");

//import routes
const AuthRoutes = require("./routes/auth.routes");
const UsersRoutes = require("./routes/users.routes");
const CustomersRoutes = require("./routes/customers.routes");
const SuppliersRoutes = require("./routes/suppliers.routes");
const AdminStockRoutes = require("./routes/admin-stock.routes");

// allow Cross-Origin calls to this app
app.use(cors({ origin: "*" }));

// routes
app.use("/api/auth", AuthRoutes);

app.use("/api/customers", auth, CustomersRoutes);

//admin routes
app.use("/api/admin-stock", admin, AdminStockRoutes);
app.use("/api/users", admin, UsersRoutes);
app.use("/api/suppliers", admin, SuppliersRoutes);

app.get("/", (req, res) => {
	res.json({
		message: "API is online",
	});
});

// handle errors
app.use(errorHandler);
module.exports = app;
