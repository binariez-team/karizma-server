const express = require("express");
const router = express.Router();
const { auth, admin } = require("../middleware/auth");

const CustomersController = require("../controllers/CustomersController");

router.get("/user/:user_id", auth, CustomersController.getCustomersByUserId);
router.get(
  "/user/:user_id/:account_id",
  auth,
  CustomersController.getCustomerByIdAndUserId
);

//admin routes
router.use(admin);

router.get("/", CustomersController.getAllCustomers);
router.get("/:id", CustomersController.getCustomerById);
router.post("/", CustomersController.createCustomer);
router.put("/:id", CustomersController.updateCustomer);
router.delete("/:id", CustomersController.deleteCustomer);

module.exports = router;
