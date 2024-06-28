const express = require("express");
const router = express.Router();

const PaymentController = require("../controllers/PaymentController");

router.post("/customer", PaymentController.addCustomerPayment);
router.put("/customer", PaymentController.editCustomerPayment);
router.post("/supplier", PaymentController.addSupplierPayment);

router.delete("/:payment_id", PaymentController.deletePayment);

module.exports = router;
