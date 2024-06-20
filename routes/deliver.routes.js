const express = require("express");
const router = express.Router();

const DeliverController = require("../controllers/DeliverController");

router.post("/invoice", DeliverController.createDeliverInvoice);

module.exports = router;
