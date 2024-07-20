const express = require("express");
const router = express.Router();

const ReportController = require("../controllers/ReportController");

router.get("/total-sales/:start/:end", ReportController.getTotalSales);

module.exports = router;
