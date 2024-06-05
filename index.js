const app = require("./app");
const cors = require("cors");
const auth = require("./middleware/auth");
const errorHandler = require("./middleware/errorHandler");

//import routes
const AuthRoutes = require("./routes/auth.routes");
const UsersRoutes = require("./routes/users.routes");

// allow Cross-Origin calls to this app
app.use(cors({ origin: "*" }));

// routes
app.use("/api/auth", AuthRoutes);
app.use("/api/users", auth, UsersRoutes);

// handle errors
app.use(errorHandler);
module.exports = app;
