const express = require("express");
const router = express.Router();
const { admin } = require("../middleware/auth");

const BalanceController = require("../controllers/BalanceController");

router.get("/", BalanceController.getBalance);
router.get("/user", BalanceController.getBalanceByUserId);
router.get("/all", admin, BalanceController.getAllUsersBalance);

// get cash transactions history
router.get("/transactions/:start&:end", BalanceController.getCashTransactions);
// correct cash balance manually
router.post("/correct", BalanceController.correctBalance);

//money transfer
router.post("/transfer", BalanceController.transferMoney);
router.put("/transfer", BalanceController.updateTransfer);
router.delete("/transfer/:id", BalanceController.deleteTransfer);

router.get("/transfer/accounts", BalanceController.getTransferAccounts);

module.exports = router;
