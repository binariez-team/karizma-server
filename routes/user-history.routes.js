const express = require("express");
const router = express.Router();

const UserHistoryController = require("../controllers/UserHistoryController");

router.get("/deliver/pending", UserHistoryController.fetchPendingInvoices);
router.post("/deliver/search", UserHistoryController.fetchDeliverHistory);

module.exports = router;
