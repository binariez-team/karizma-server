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
        // The route is declared as `/:journal_id` (routes/expense.routes.js), so reading
        // `payment_id` here yielded undefined: the DELETE bound NULL, matched no rows and
        // still returned 200, so the UI reported success while nothing was removed.
        const { journal_id } = req.params;
        if (!journal_id) {
            return res
                .status(400)
                .json({ message: "journal_id is required." });
        }

        const result = await Expense.deleteExpense(database_id, journal_id);

        // Never report success for a delete that removed nothing — that is what hid the
        // bug above. A miss here means the voucher does not exist or belongs to another
        // database_id; both are "not found" from this caller's point of view.
        if (!result || result.deleted === 0) {
            return res.status(404).json({ message: "Expense not found." });
        }

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};
