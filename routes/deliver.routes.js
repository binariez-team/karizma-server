const express = require("express");
const router = express.Router();

const DeliverController = require("../controllers/DeliverController");

router.post("/invoice", DeliverController.createDeliverInvoice);
router.put("/invoice", DeliverController.updateDeliverInvoice);
router.delete("/invoice/:id", DeliverController.deleteDeliverInvoice);

module.exports = router;
