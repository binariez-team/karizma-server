const express = require("express");
const router = express.Router();

const UserHistoryController = require("../controllers/UserHistoryController");

router.post("/deliver/search", UserHistoryController.fetchDeliverHistory);

module.exports = router;
