const express = require("express");
const router = express.Router();
const { admin } = require("../middleware/auth");

const CustomersController = require("../controllers/CustomersController");

router.get("/user", CustomersController.getCustomersByUserId);
router.get(
  "/user/:account_id",

  CustomersController.getCustomerByIdAndUserId
);
router.post("/user", CustomersController.createUserCustomer);
router.put("/user/:account_id", CustomersController.updateUserCustomer);
router.delete(
  "/user/:account_id",

  CustomersController.deleteUserCustomer
);

router.get(
  "/user/transactions/:account_id&:start&:end",
  CustomersController.getCustomerBalance
);

//admin routes
router.use(admin);

router.get("/", CustomersController.getAllCustomers);
router.get("/:id", CustomersController.getCustomerById);
router.post("/", CustomersController.createCustomer);
router.put("/:id", CustomersController.updateCustomer);
router.delete("/:id", CustomersController.deleteCustomer);

module.exports = router;
