const express = require("express");
const router = express.Router();

const HistoryController = require("../controllers/HistoryController");
router.post("/sales/search", HistoryController.fetchSalesHistory);

module.exports = router;
