const UserHistory = require("../models/UserHistoryModel");
const User = require("../models/UserModel");

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

exports.approvePendingInvoice = async (req, res, next) => {
	try {
		let io = req.io;
		let id = req.body.id;
		let { user_id } = req.body;
		let { admin_id } = req.body;
		let invoices = await UserHistory.approvePendingInvoice(
			id,
			user_id,
			admin_id
		);
		const [user] = await User.getById(user_id);

		// this is to inform admin that user approved invoice
		io.emit("deliverCompleted", user.username);
		res.status(200).send(invoices);
	} catch (error) {
		next(error);
	}
};
