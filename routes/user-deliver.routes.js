const express = require("express");
const router = express.Router();

// const DeliverController = require("../controllers/DeliverController");
const UserDeliverController = require("../controllers/UserDeliver.controller");

// router.post("/invoice", DeliverController.createDeliverInvoice);
// router.put("/invoice", DeliverController.updateDeliverInvoice);
// router.delete("/invoice/:id", DeliverController.deleteDeliverInvoice);

router.get("/users", UserDeliverController.getUsers);

module.exports = router;
