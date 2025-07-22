const express = require("express");
const router = express.Router();

const PurchaseController = require("../controllers/PurchaseController");
//orders
router.post("", PurchaseController.addOrder);
router.put("", PurchaseController.editOrder);
router.delete("/:id", PurchaseController.deleteOrder);

module.exports = router;
