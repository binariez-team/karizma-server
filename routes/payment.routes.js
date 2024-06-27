const express = require("express");
const router = express.Router();

const PaymentController = require("../controllers/PaymentController");

router.post("/customer", PaymentController.addCustomerPayment);
router.post("/supplier", PaymentController.addSupplierPayment);

module.exports = router;
