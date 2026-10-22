const crypto = require("crypto");

// Secret of the login (access) token, sent as x-access-token. Moved here unchanged from
// the three copies that used to sit in middleware/auth.js, AuthController and
// ProfileController, so every token issued so far stays valid. It is deliberately NOT
// read from .env JWT_SECRET: switching would log every user out.
const ACCESS_SECRET = "$3a#_cJDUV-$QsRewWXcyH-Xdji8#%^$*(_ZkfNdI@#!D-Nv0E_M3a";

// Secret of the reports unlock token (x-reports-token, reports v2). Derived from the
// access secret but different from it, so one kind of token can never pass as the
// other: `auth` accepts any JWT signed with ACCESS_SECRET, and a reports token sent as
// x-access-token must fail there with 401.
const REPORTS_SECRET = crypto
    .createHmac("sha256", ACCESS_SECRET)
    .update("karizma:reports-token:v1")
    .digest("hex");

module.exports = { ACCESS_SECRET, REPORTS_SECRET };
