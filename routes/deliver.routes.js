const express = require("express");
const router = express.Router();

const DeliverController = require("../controllers/DeliverController");

router.get("/recipients", DeliverController.getRecipients);
router.get(
    "/recipients/:database_id/stock",
    DeliverController.getRecipientStock,
);
// deprecated alias for builds that predate /recipients
router.get("/users", DeliverController.getRecipients);
router.post("/invoice", DeliverController.createDeliverInvoice);
router.put("/invoice", DeliverController.updateDeliverInvoice);
router.delete("/invoice/:id", DeliverController.deleteDeliverInvoice);

module.exports = router;
