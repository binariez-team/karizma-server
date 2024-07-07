const Expense = require("../models/ExpenseModel");

exports.getExpenseDetails = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const expenses = await Expense.getExpenseDetails(user_id);
		res.json(expenses);
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

exports.createExpense = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const data = req.body;
		await Expense.createExpense(user_id, data);
		res.json({ message: "Expense created successfully" });
	} catch (err) {
		next(err);
	}
};
exports.updateExpense = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const data = req.body;
		await Expense.updateExpense(user_id, data);
		res.json({ message: "Expense updated successfully" });
	} catch (err) {
		next(err);
	}
};

exports.deleteExpense = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const payment_id = req.params.payment_id;
		const result = await Expense.deleteExpense(user_id, payment_id);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};
