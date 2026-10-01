const express = require("express");
const router = express.Router();
const { admin } = require("../middleware/auth");

const PaymentController = require("../controllers/Payment.controller");

router.post("/customer", PaymentController.addCustomerPayment);
router.put("/customer", PaymentController.editCustomerPayment);
// Supplier payments are an admin feature (the /suppliers router is admin-only and
// the supplier payment dialog lives under admin/suppliers).
router.post("/supplier", admin, PaymentController.addSupplierPayment);
router.put("/supplier", admin, PaymentController.editSupplierPayment);

// Open to users for customer payments; the controller only lets admins delete
// supplier payments.
router.delete("/:payment_id", PaymentController.deletePayment);

module.exports = router;
