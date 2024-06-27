const Payment = require("../models/PaymentModel");

exports.addCustomerPayment = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const paymentData = req.body;
		const result = await Payment.addCustomerPayment(user_id, paymentData);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};
exports.addSupplierPayment = async (req, res, next) => {};
