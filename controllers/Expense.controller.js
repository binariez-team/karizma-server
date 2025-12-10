const Expense = require("../models/ExpenseModel");

exports.getExpenseDetails = async (req, res, next) => {
    try {
        let { expense, start, end } = req.body;
        const { database_id } = req.user;
        const expenses = await Expense.getExpenseDetails(
            expense,
            start,
            end,
            database_id
        );
        res.status(200).send(expenses);
    } catch (err) {
        next(err);
    }
};

exports.getExpenseAccounts = async (req, res, next) => {
    try {
        const accounts = await Expense.getExpenseAccounts();
        res.json(accounts);
    } catch (err) {
        next(err);
    }
};

// create
exports.createExpense = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const data = req.body;
        await Expense.createExpense(database_id, data);
        res.json({ message: "Expense created successfully" });
    } catch (err) {
        next(err);
    }
};

// update
exports.updateExpense = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const data = req.body;
        await Expense.updateExpense(database_id, data);
        res.json({ message: "Expense updated successfully" });
    } catch (err) {
        next(err);
    }
};

// delete
exports.deleteExpense = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const payment_id = req.params.payment_id;
        const result = await Expense.deleteExpense(database_id, payment_id);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};
