const express = require("express");
const router = express.Router();

const HistoryController = require("../controllers/HistoryController");

router.post("/sales/search", HistoryController.fetchSalesHistory);
router.post("/payment/search", HistoryController.fetchPaymentHistory);
router.post(
	"/money-transfer/search",
	HistoryController.fetchUserMoneyTransferHistory
);
router.post("/return/search", HistoryController.fetchReturnHistory);

module.exports = router;
