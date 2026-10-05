const express = require("express");
const router = express.Router();

const DeliverController = require("../controllers/DeliverController");

// Deprecated: the merged deliver screen uses GET /deliver/recipients. Kept for older
// web/Electron builds; same handler, so it cannot offer a wider list.
router.get("/users", DeliverController.getRecipients);

module.exports = router;
