const jwt = require("jsonwebtoken");

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

exports.auth = verifyToken;
exports.admin = verifyAdmin;
