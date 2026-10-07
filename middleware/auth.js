const jwt = require("jsonwebtoken");
const pool = require("../config/database");

const verifyToken = (req, res, next) => {
	const token =
		req.body.token || req.query.token || req.headers["x-access-token"];

	if (!token) {
		return res.status(403).send("A token is required for authentication");
	}
	try {
		const decoded = jwt.verify(
			token,
			"$3a#_cJDUV-$QsRewWXcyH-Xdji8#%^$*(_ZkfNdI@#!D-Nv0E_M3a"
		);
		req.user = decoded;
	} catch (err) {
		return res.status(401).send("Invalid Token");
	}
	return next();
};

const verifyAdmin = (req, res, next) => {
	verifyToken(req, res, () => {
		const user = req.user;
		if (user.user_type !== "admin") {
			return res.status(403).send("No enough permissions to access");
		}
		return next();
	});
};

// Gate a route on one of the permission flags stored on the users row.
//
// Permissions are NOT in the JWT (it only carries user_id, database_id, username and
// user_type), and the copy the client holds is only for showing/hiding buttons — so
// the flag is read from the database on every request. That also makes a revoke take
// effect immediately instead of at the user's next login.
//
// Admins pass unconditionally: they hold every permission implicitly, and some gated
// endpoints (e.g. /user-stock/correction) are also what the admin screens post to.
//
// Must run after `auth`, which populates req.user.
const requirePermission = (permission) => async (req, res, next) => {
	if (req.user?.user_type === "admin") return next();
	try {
		const [[row]] = await pool.query(
			`SELECT ?? AS allowed FROM users WHERE user_id = ? AND is_deleted = 0`,
			[permission, req.user.user_id]
		);
		if (!row || !Number(row.allowed)) {
			return res
				.status(403)
				.send({ message: "You don't have permission to do this" });
		}
		return next();
	} catch (error) {
		return next(error);
	}
};

// Gate a route on the caller being the OWNER of their database: the admin account
// or a user account — never one of their staff. Staff share the owner's database_id,
// so database_id alone cannot tell them apart; user_type (signed into the token) does.
// Anything else, including a missing or unknown user_type, is refused.
//
// Must run after `auth`, which populates req.user.
const OWNER_TYPES = new Set(["admin", "user"]);
const requireOwner = (req, res, next) => {
	if (!OWNER_TYPES.has(req.user?.user_type)) {
		return res
			.status(403)
			.send({ message: "Only the account owner can do this" });
	}
	return next();
};

exports.auth = verifyToken;
exports.admin = verifyAdmin;
exports.requirePermission = requirePermission;
exports.owner = requireOwner;
