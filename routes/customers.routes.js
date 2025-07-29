const express = require("express");
const router = express.Router();
const { admin } = require("../middleware/auth");

const CustomersController = require("../controllers/CustomersController");

router.get("/debts", CustomersController.getCustomerDebts);

router.get("/", CustomersController.getCustomersByUserId);
router.get("/:account_id", CustomersController.getCustomerByIdAndUserId);

router.post("/", CustomersController.createUserCustomer);
router.put("/", CustomersController.updateUserCustomer);
router.delete(
	"/:account_id",

	CustomersController.deleteUserCustomer
);

router.get(
	"/transactions/:account_id&:start&:end",
	CustomersController.getCustomerBalance
);

router.get(
	"/:account_id/purchases/latest",
	CustomersController.getCustomerLatestPurchases
);
router.get("/:account_id/balance", CustomersController.getCustomerTotalBalance);

//admin routes
router.use(admin);

// router.get("/", CustomersController.getAllCustomers);
// router.get("/:id", CustomersController.getCustomerById);
// router.post("/", CustomersController.createCustomer);
// router.put("/:id", CustomersController.updateCustomer);
// router.delete("/:id", CustomersController.deleteCustomer);

module.exports = router;
