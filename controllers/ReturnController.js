const ReturnModel = require("../models/ReturnModel");

exports.addReturn = async (req, res, next) => {
	const user_id = req.user.user_id;
	const order = req.body.invoice;
	const payment = req.body.payment;
	const items = order.items;
	delete order.items;

	try {
		const result = await ReturnModel.addReturn(user_id, order, items, payment);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
};

exports.editReturn = async (req, res, next) => {
	const order = req.body;
	const items = order.items;
	delete order.items;
	const user_id = req.user.user_id;

	try {
		const result = await ReturnModel.editReturn(user_id, order, items);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

exports.deleteReturn = async (req, res, next) => {
	const user_id = req.user.user_id;
	const order_id = req.params.order_id;

	try {
		await ReturnModel.deleteReturn(user_id, order_id);
		res.status(200).json({ message: "Order deleted successfully" });
	} catch (error) {
		next(error);
	}
};
