const express = require("express");
const router = express.Router();

const AuthController = require("../controllers/AuthController");
const { auth } = require("../middleware/auth");

router.post("/login", AuthController.login);
router.post(
    "/verify-reports-password",
    auth,
    AuthController.verifyReportsPassword,
);
router.post(
    "/change-reports-password",
    auth,
    AuthController.changeReportsPassword,
);

module.exports = router;
