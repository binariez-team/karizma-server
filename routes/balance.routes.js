const express = require("express");
const router = express.Router();
const { admin } = require("../middleware/auth");

const BalanceController = require("../controllers/BalanceController");

router.get("/user", BalanceController.getBalanceByUserId);
router.get("/all", admin, BalanceController.getAllUsersBalance);

module.exports = router;
