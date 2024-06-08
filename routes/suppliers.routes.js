const express = require("express");
const router = express.Router();

const SuppliersController = require("../controllers/SuppliersController");

//admin routes
router.get("/", SuppliersController.getAllSuppliers);
router.get("/:id", SuppliersController.getSupplierById);
router.post("/", SuppliersController.createSupplier);
router.put("/:id", SuppliersController.updateSupplier);
router.delete("/:id", SuppliersController.deleteSupplier);

module.exports = router;
