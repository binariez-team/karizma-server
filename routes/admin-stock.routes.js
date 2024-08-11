const express = require("express");
const router = express.Router();

const AdminStockController = require("../controllers/AdminStockController");
const CategoryController = require("../controllers/CategoryController");

router.get("/items", AdminStockController.getAllProducts);
router.post("/items", AdminStockController.createProduct);
router.put("/items", AdminStockController.updateProduct);
router.delete("/items/:id", AdminStockController.deleteProduct);

router.get("/categories", CategoryController.getCategories);
router.post("/categories", CategoryController.createCategory);
router.put("/categories", CategoryController.updateCategory);
router.delete("/categories/:id", CategoryController.deleteCategory);
router.patch("/categories/sort", CategoryController.sortCategories);

module.exports = router;
