const express = require("express");
const router = express.Router();

const UserStockController = require("../controllers/UserStockController");
router.get("/", UserStockController.getAllProducts);

module.exports = router;
