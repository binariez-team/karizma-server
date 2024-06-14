const express = require("express");
const router = express.Router();

const AdminStockController = require("../controllers/AdminStockController");

router.get("/items", AdminStockController.getAllProducts);

module.exports = router;
