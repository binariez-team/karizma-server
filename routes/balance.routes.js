const express = require("express");
const router = express.Router();
const { admin } = require("../middleware/auth");

const BalanceController = require("../controllers/BalanceController");

router.get("/user", BalanceController.getBalanceByUserId);
router.get("/all", admin, BalanceController.getAllUsersBalance);

//money transfer
router.post("/transfer", BalanceController.transferMoney);
router.put("/transfer", BalanceController.updateTransfer);
router.delete("/transfer/:id", BalanceController.deleteTransfer);
router.get("/transfer/accounts", BalanceController.getTransferAccounts);

module.exports = router;
