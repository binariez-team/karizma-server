const express = require("express");
const router = express.Router();

const AdminStockController = require("../controllers/AdminStockController");

router.get("/items", AdminStockController.getAllProducts);
router.post("/items", AdminStockController.createProduct);

module.exports = router;
