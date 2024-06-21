const express = require("express");
const router = express.Router();

const HistoryController = require("../controllers/HistoryController");

router.post("/deliver/search", HistoryController.fetchDeliverHistory);

module.exports = router;
