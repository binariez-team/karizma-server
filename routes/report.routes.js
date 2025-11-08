const express = require("express");
const router = express.Router();

const ReportController = require("../controllers/ReportController");

router.get("/total-sales/:start/:end", ReportController.getTotalSales);

router.get("/stock-value", ReportController.getStockValue);

module.exports = router;
