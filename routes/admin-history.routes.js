const express = require("express");
const router = express.Router();

const AdminHistoryController = require("../controllers/AdminHistoryController");

router.post("/deliver/search", AdminHistoryController.fetchDeliverHistory);
router.post(
	"/money-transfer/search",
	AdminHistoryController.fetchMoneyTransferHistory
);
router.post(
	"/suppliers-payment/search",
	AdminHistoryController.fetchSuppliersPaymentHistory
);

module.exports = router;
