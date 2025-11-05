const express = require("express");
const router = express.Router();

const HistoryController = require("../controllers/HistoryController");

router.get("/product/:id", HistoryController.getProductHistoryById);

router.post("/sales/search", HistoryController.fetchSalesHistory);
router.post("/sales/details", HistoryController.fetchOrderItemsById);

router.post("/products/search", HistoryController.fetchProductsSalesHistory);

router.post("/return/search", HistoryController.fetchReturnHistory);
router.post("/returns/details", HistoryController.fetchReturnOrderItemsById);

router.post("/payment/search", HistoryController.fetchPaymentHistory);
router.post("/dispose/search", HistoryController.fetchDisposeHistory);

module.exports = router;
