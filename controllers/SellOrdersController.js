const SellOrders = require("../models/SellOrdersModel");
exports.addOrder = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const order = req.body.invoice;
		const payment = req.body.payment;
		const items = order.items;
		delete order.items;

		order.user_id = user_id;
		const result = await SellOrders.addOrder(order, items, user_id, payment);
		const new_order = await SellOrders.getAddedOrderById(result.order, user_id);
		res.status(201).json(new_order);
	} catch (error) {
		next(error);
	}
};
exports.editOrder = async (req, res, next) => {
	try {
		const order = req.body;
		const items = order.items;
		delete order.items;
		const user_id = req.user.user_id;

		const result = await SellOrders.editOrder(order, items, user_id);
		const new_order = await SellOrders.getAddedOrderById(
			result.insertId,
			user_id
		);
		res.status(201).json(new_order);
	} catch (error) {
		next(error);
	}
};
exports.deleteOrder = (req, res, next) => {
	try {
		const order_id = req.params.id;
		const user_id = req.user.user_id;
		SellOrders.deleteOrder(order_id, user_id);
		res.status(200).json({ message: "Order deleted successfully" });
	} catch (error) {
		next(error);
	}
};
