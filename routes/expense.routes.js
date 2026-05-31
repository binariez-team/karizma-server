const express = require("express");
const router = express.Router();

const expenseController = require("../controllers/Expense.controller");

router.get("/accounts", expenseController.getExpenseAccounts);
router.post("/search", expenseController.getExpenseDetails);
router.post("/", expenseController.createExpense);
router.put("/:journal_id", expenseController.updateExpense);
router.delete("/:journal_id", expenseController.deleteExpense);

module.exports = router;
