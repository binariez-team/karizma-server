const AdminHistory = require("../models/AdminHistoryModel");

exports.fetchDeliverHistory = async (req, res, next) => {
	try {
		let criteria = req.body;
		let invoices = await AdminHistory.fetchDeliverHistory(criteria);
		res.status(200).send(invoices);
	} catch (error) {
		next(error);
	}
};

exports.fetchMoneyTransferHistory = async (req, res, next) => {
	try {
		let criteria = req.body;
		let invoices = await AdminHistory.fetchMoneyTransferHistory(criteria);
		console.log(invoices);
		res.status(200).send(invoices);
	} catch (error) {
		next(error);
	}
};

exports.fetchSuppliersPaymentHistory = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		let criteria = req.body;
		let payments = await AdminHistory.fetchSuppliersPaymentHistory(
			user_id,
			criteria
		);
		res.status(200).send(payments);
	} catch (error) {
		next(error);
	}
};
