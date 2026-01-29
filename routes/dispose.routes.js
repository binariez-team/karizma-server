const express = require("express");
const router = express.Router();

const disposeController = require("../controllers/Dispose.controller");

router.post("", disposeController.createDispose);
router.put("/:dispose_id", disposeController.updateDispose);
router.delete("/:dispose_id", disposeController.deleteDispose);

module.exports = router;
