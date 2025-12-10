const express = require("express");
const router = express.Router();

const staffController = require("../controllers/Staff.controller");

router.get("/", staffController.getAll);
router.post("/", staffController.createStaff);
router.put("/", staffController.updateStaff);
router.delete("/:id", staffController.deleteStaff);

module.exports = router;
