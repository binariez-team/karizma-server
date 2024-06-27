const History = require("../models/HistoryModel");

exports.fetchSalesHistory = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		let criteria = req.body;
		let invoices = await History.fetchSalesHistory(user_id, criteria);
		res.status(200).send(invoices);
	} catch (error) {
		next(error);
	}
};

exports.fetchPaymentHistory = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		let criteria = req.body;
		let payments = await History.fetchPaymentHistory(user_id, criteria);
		res.status(200).send(payments);
	} catch (error) {
		next(error);
	}
};
