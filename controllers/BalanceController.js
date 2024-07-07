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
