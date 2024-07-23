const express = require("express");
const router = express.Router();

const ReturnController = require("../controllers/ReturnController");

router.post("", ReturnController.addReturn);
router.put("", ReturnController.editReturn);
router.delete("/:order_id", ReturnController.deleteReturn);

module.exports = router;
