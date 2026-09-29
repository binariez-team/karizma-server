const express = require("express");
const router = express.Router();

const {
    fetchDeliverHistory,
    fetchDeliverItems,
    fetchMoneyTransferHistory,
    fetchPurchaseHistory,
    fetchPurchaseItems,
    fetchSuppliersPaymentHistory,
} = require("../controllers/AdminHistoryController");

router.post("/deliver/search", fetchDeliverHistory);
router.get("/deliver/:order_id/items", fetchDeliverItems);
router.post("/money-transfer/search", fetchMoneyTransferHistory);

router.post("/purchase/search", fetchPurchaseHistory);
router.get("/purchase/:order_id/items", fetchPurchaseItems);
router.post("/suppliers-payment/search", fetchSuppliersPaymentHistory);

module.exports = router;
