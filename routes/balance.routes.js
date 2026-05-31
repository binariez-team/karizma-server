const express = require("express");
const router = express.Router();
const { admin } = require("../middleware/auth");

const BalanceController = require("../controllers/BalanceController");

router.get("/", BalanceController.getBalance);
router.get("/user", BalanceController.getBalanceByUserId);
router.get("/all", admin, BalanceController.getAllUsersBalance);

// get cash transactions history
router.get(
    "/transactions/:start&:end&:account",
    BalanceController.getCashTransactions,
);

router.get("/transfer/accounts", BalanceController.getTransferAccounts);

router.post("/self-transfer", BalanceController.selfTransfer);

module.exports = router;
