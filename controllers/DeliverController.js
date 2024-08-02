const DeliverInvoice = require("../models/DeliverModel");
const User = require("../models/UserModel");

exports.createDeliverInvoice = async (req, res, next) => {
	try {
		const io = req.io;
		const admin = req.user;
		const { order, items } = req.body;

		await DeliverInvoice.create(order, items, admin);
		const [user] = await User.getById(order.user_id_fk);
		io.emit("deliverAdded", user.username);
		res.status(201).send({
			message: "Order created successfully!",
		});
	} catch (error) {
		next(error);
	}
};

exports.updateDeliverInvoice = async (req, res, next) => {
	try {
		const admin = req.user;
		const { order, items } = req.body;
		await DeliverInvoice.update(order, items, admin);
		res.status(200).send({
			message: "Order updated successfully!",
		});
	} catch (error) {
		console.log(error);
		if (error.message === "approved") {
			return res.status(400).send({
				error: "Order has been approved by user!",
			});
		} else {
			next(error);
		}
	}
};

exports.deleteDeliverInvoice = async (req, res, next) => {
	try {
		const order_id = req.params.id;
		const admin_id = req.user.user_id;
		await DeliverInvoice.delete(order_id, admin_id);
		res.status(200).send({
			message: "Order deleted successfully!",
		});
	} catch (error) {
		if (error.message === "approved") {
			return res.status(400).send({
				error: "Order has been approved by user!",
			});
		} else {
			next(error);
		}
	}
};
