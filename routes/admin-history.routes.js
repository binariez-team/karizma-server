const express = require("express");
const router = express.Router();

const {
    fetchDeliverHistory,
    fetchMoneyTransferHistory,
    fetchPurchaseHistory,
    fetchSuppliersPaymentHistory,
} = require("../controllers/AdminHistoryController");

router.post("/deliver/search", fetchDeliverHistory);
router.post("/money-transfer/search", fetchMoneyTransferHistory);

router.post("/purchase/search", fetchPurchaseHistory);
router.post("/suppliers-payment/search", fetchSuppliersPaymentHistory);

module.exports = router;
