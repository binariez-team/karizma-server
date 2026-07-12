const express = require("express");
const router = express.Router();

const UserStockController = require("../controllers/UserStockController");
const AdminStockController = require("../controllers/AdminStockController");

router.post("/dispose", UserStockController.disposeProducts);
router.put("/dispose", UserStockController.updateDispose);
router.delete("/dispose/:id", UserStockController.deleteDispose);

router.patch("/visibility", UserStockController.updateVisibility);

router.get("/", UserStockController.getAllProducts);
router.get("/:id", UserStockController.getProductById);
router.put("/:id", UserStockController.updateProduct);

router.post("/correction", AdminStockController.addStockCorrection);

module.exports = router;
