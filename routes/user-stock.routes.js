const express = require("express");
const router = express.Router();

const UserStockController = require("../controllers/UserStockController");
const AdminStockController = require("../controllers/AdminStockController");
const CategoryController = require("../controllers/CategoryController");
const BrandController = require("../controllers/BrandController");
const { requirePermission } = require("../middleware/auth");

router.post("/dispose", UserStockController.disposeProducts);
router.put("/dispose", UserStockController.updateDispose);
router.delete("/dispose/:id", UserStockController.deleteDispose);

router.patch("/visibility", UserStockController.updateVisibility);

// category / brand lists for the stock table filters (read-only; they are global
// tables, edited under /admin-stock). Must stay above "/:id".
router.get("/categories", CategoryController.getCategories);
router.get("/brands", BrandController.getBrands);

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
