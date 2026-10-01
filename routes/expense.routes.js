const express = require("express");
const router = express.Router();
const { requirePermission } = require("../middleware/auth");

const expenseController = require("../controllers/Expense.controller");

// The Expenses page (list, edit, delete) is shown only with users.view_expenses;
// admins always pass. Adding an expense ("Submit Expense" on home) and the account
// list its dialog loads stay open to every user.
router.get("/accounts", expenseController.getExpenseAccounts);
router.post(
    "/search",
    requirePermission("view_expenses"),
    expenseController.getExpenseDetails,
);
router.post("/", expenseController.createExpense);
router.put(
    "/:journal_id",
    requirePermission("view_expenses"),
    expenseController.updateExpense,
);
router.delete(
    "/:journal_id",
    requirePermission("view_expenses"),
    expenseController.deleteExpense,
);

module.exports = router;
