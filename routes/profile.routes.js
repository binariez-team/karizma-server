const express = require("express");
const router = express.Router();

const ProfileController = require("../controllers/ProfileController");

router.put("/", ProfileController.updateProfile);
router.put("/password", ProfileController.updatePassword);

module.exports = router;
