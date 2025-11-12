const express = require("express");
const router = express.Router();

const expenseController = require("../controllers/Expense.controller");

router.post("/", expenseController.getExpenseDetails);
router.get("/accounts", expenseController.getExpenseAccounts);
router.post("/create", expenseController.createExpense);
router.put("/", expenseController.updateExpense);
router.delete("/:payment_id", expenseController.deleteExpense);

module.exports = router;
