const express = require("express");
const router = express.Router();

const UserController = require("../controllers/UserController");

// router.post('/login', UserController.login);
router.get("", UserController.getUsers);
router.post("", UserController.createUser);
router.put("", UserController.updateUser);
router.delete("/:id", UserController.deleteUser);

module.exports = router;
