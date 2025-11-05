const PurchaseOrders = require("../models/PurchaseModel");

// add order
exports.addOrder = async (req, res, next) => {
	try {
		const order = req.body.invoice;
		const items = order.items;
		const payment = req.body.payment;
		const user = req.user;

		delete order.items;

		const result = await PurchaseOrders.addOrder(
			order,
			items,
			payment,
			user
		);

		const new_order = await PurchaseOrders.getAddedOrderById(result.order);
		res.status(201).json(new_order);
	} catch (error) {
		next(error);
	}
};

// edit
exports.editOrder = async (req, res, next) => {
	try {
		const order = req.body;
		const items = order.items;
		delete order.items;

		const { user_id } = req.user;

		const result = await PurchaseOrders.editOrder(order, items, user_id);
		const new_order = await PurchaseOrders.getAddedOrderById(
			result.insertId
		);
		res.status(201).json(new_order);
	} catch (error) {
		next(error);
	}
};

// delete
exports.deleteOrder = async (req, res, next) => {
	try {
		const order_id = req.params.id;
		await PurchaseOrders.deleteOrder(order_id);
		res.status(200).json({ message: "Order deleted successfully" });
	} catch (error) {
		next(error);
	}
};
