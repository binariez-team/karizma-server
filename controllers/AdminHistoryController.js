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
