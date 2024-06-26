const express = require("express");
const router = express.Router();

const AdminHistoryController = require("../controllers/AdminHistoryController");

router.post("/deliver/search", AdminHistoryController.fetchDeliverHistory);

module.exports = router;
