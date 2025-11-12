const express = require("express");
const router = express.Router();

const disposeController = require("../controllers/Dispose.controller");

router.post("", disposeController.createDispose);

module.exports = router;
