const UserHistory = require("../models/UserHistoryModel");

exports.fetchDeliverHistory = async (req, res, next) => {
	try {
		let user = req.user;
		let criteria = req.body;
		let invoices = await UserHistory.fetchDeliverHistory(
			user.user_id,
			criteria
		);
		res.status(200).send(invoices);
	} catch (error) {
		next(error);
	}
};

exports.fetchPendingInvoices = async (req, res, next) => {
	try {
		let user = req.user;
		let invoices = await UserHistory.fetchPendingInvoices(user.user_id);
		res.status(200).send(invoices);
	} catch (error) {
		next(error);
	}
};
