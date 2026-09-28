const express = require("express");
const router = express.Router();

const UserStockController = require("../controllers/UserStockController");
const AdminStockController = require("../controllers/AdminStockController");
const { requirePermission } = require("../middleware/auth");

router.post("/dispose", UserStockController.disposeProducts);
router.put("/dispose", UserStockController.updateDispose);
router.delete("/dispose/:id", UserStockController.deleteDispose);

router.patch("/visibility", UserStockController.updateVisibility);

router.get("/", UserStockController.getAllProducts);
router.get("/:id", UserStockController.getProductById);
router.put("/:id", UserStockController.updateProduct);

// manual ADD / REMOVE of quantity — users need users.edit_stock; admins always pass
// (the admin stock screen posts here too)
router.post(
    "/correction",
    requirePermission("edit_stock"),
    AdminStockController.addStockCorrection,
);

module.exports = router;
