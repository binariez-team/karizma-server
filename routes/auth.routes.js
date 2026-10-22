const express = require("express");
const router = express.Router();

const AuthController = require("../controllers/AuthController");
const { auth, admin } = require("../middleware/auth");

router.post("/login", AuthController.login);
router.post(
    "/verify-reports-password",
    auth,
    AuthController.verifyReportsPassword,
);
// Admin only: the password guards every user's and staff member's reports, and a
// change locks out every unlocked session (`admin` runs the token check itself)
router.post(
    "/change-reports-password",
    admin,
    AuthController.changeReportsPassword,
);

module.exports = router;
