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
exports.editCustomerPayment = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const paymentData = req.body;
		const result = await Payment.editCustomerPayment(user_id, paymentData);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

exports.deletePayment = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const payment_id = req.params.payment_id;
		const result = await Payment.deletePayment(user_id, payment_id);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

exports.addSupplierPayment = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const paymentData = req.body;
		console.log(paymentData, user_id);
		const result = await Payment.addSupplierPayment(user_id, paymentData);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

exports.editSupplierPayment = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const paymentData = req.body;
		const result = await Payment.editSupplierPayment(user_id, paymentData);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};
