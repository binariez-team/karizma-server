const express = require("express");
const router = express.Router();

const UserStockController = require("../controllers/UserStockController");
router.get("/", UserStockController.getAllProducts);
router.get("/:id", UserStockController.getProductById);
router.put("/:id", UserStockController.updateProduct);

module.exports = router;
