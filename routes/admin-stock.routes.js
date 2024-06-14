const express = require("express");
const router = express.Router();

const AdminStockController = require("../controllers/AdminStockController");

router.get("/items", AdminStockController.getAllProducts);
router.post("/items", AdminStockController.createProduct);
router.put("/items", AdminStockController.updateProduct);
router.delete("/items/:id", AdminStockController.deleteProduct);

module.exports = router;
