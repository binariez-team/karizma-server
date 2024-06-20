const SellOrders = require("../models/SellOrdersModel");
exports.addOrder = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const order = req.body;
		const items = order.items;
		delete order.items;
		console.log(order, items, user_id);
		order.user_id = user_id;
		const result = await SellOrders.addOrder(order, items, user_id);
		const new_order = await SellOrders.getAddedOrderById(result.insertId);
		res.status(201).json(new_order);
	} catch (error) {
		next(error);
	}
};
exports.editOrder = (req, res, next) => {};
exports.deleteOrder = (req, res, next) => {};
