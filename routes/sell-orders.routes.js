const express = require("express");
const router = express.Router();

const SellOrdersController = require("../controllers/SellOrdersController");
//orders
router.post("", SellOrdersController.addOrder);
router.put("", SellOrdersController.editOrder);
router.get("/:id/payment", SellOrdersController.getOrderPayment);
router.delete("/:id", SellOrdersController.deleteOrder);

module.exports = router;
