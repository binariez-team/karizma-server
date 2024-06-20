const DeliverInvoice = require("../models/DeliverModel");

exports.createDeliverInvoice = async (req, res, next) => {
	try {
		const user = req.user;
		const { order, items } = req.body;

		await DeliverInvoice.create(order, items, user);
		res.status(201).send({
			message: "Order created successfully!",
		});
	} catch (error) {
		next(error);
	}
};
