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
