const express = require("express");
const router = express.Router();

const expenseController = require("../controllers/ExpenseController");

router.get("/", expenseController.getExpenseDetails);
router.get("/accounts", expenseController.getExpenseAccounts);
router.post("/", expenseController.createExpense);
router.put("/", expenseController.updateExpense);
router.delete("/:payment_id", expenseController.deleteExpense);

module.exports = router;
