const express = require("express");
const router = express.Router();

const UserStockController = require("../controllers/UserStockController");
router.post("/dispose", UserStockController.disposeProducts);
router.put("/dispose", UserStockController.updateDispose);
router.delete("/dispose/:id", UserStockController.deleteDispose);

router.get("/", UserStockController.getAllProducts);
router.get("/:id", UserStockController.getProductById);
router.put("/:id", UserStockController.updateProduct);

module.exports = router;
