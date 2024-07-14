const Balance = require("../models/BalanceModel");

//get user balance
exports.getBalanceByUserId = async (req, res, next) => {
	const userId = req.user.user_id;
	try {
		const balance = await Balance.getBalanceByUserId(userId);
		res.status(200).json(balance);
	} catch (error) {
		next(error);
	}
};

//get all users balance
exports.getAllUsersBalance = async (req, res, next) => {
	try {
		const balance = await Balance.getAllUsersBalance();
		res.status(200).json(balance);
	} catch (error) {
		next(error);
	}
};

//transfer money
exports.transferMoney = async (req, res, next) => {
	const user_id = req.user.user_id;
	const paymentData = req.body;
	try {
		const transfer = await Balance.transferMoney(user_id, paymentData);
		res.status(200).json(transfer);
	} catch (error) {
		next(error);
	}
};

//update transfer
exports.updateTransfer = async (req, res, next) => {
	const user_id = req.user.user_id;
	const paymentData = req.body;
	try {
		const transfer = await Balance.updateTransfer(user_id, paymentData);
		res.status(200).json(transfer);
	} catch (error) {
		next(error);
	}
};

//delete transfer
exports.deleteTransfer = async (req, res, next) => {
	const user_id = req.user.user_id;
	const journal_id = req.params.id;
	try {
		const transfer = await Balance.deleteTransfer(user_id, journal_id);
		res.status(200).json(transfer);
	} catch (error) {
		next(error);
	}
};

//get transfer accounts
exports.getTransferAccounts = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const accounts = await Balance.getTransferAccounts(user_id);
		res.status(200).json(accounts);
	} catch (error) {
		next(error);
	}
};
