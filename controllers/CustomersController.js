const Customer = require("../models/CustomersModel");
const Accounts = require("../models/AccountsModel");

// get customer's debts
exports.getCustomerDebts = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const result = await Customer.getCustomerDebts(user_id);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
};

// add manual customer debt
exports.addManualDebt = async (req, res, next) => {
	try {
		const io = req.io;
		const user = req.user;
		let data = req.body;
		const result = await Customer.addManualDebt(data, user.user_id);

		io.emit("addedCustomerDebt", user);

		res.status(201).send(result);
	} catch (error) {
		next(error);
	}
};

//customer model related to user//
// get customers by user id
exports.getCustomersByUserId = async (req, res, next) => {
	const user_id = req.user.user_id;
	try {
		const customers = await Customer.getCustomersByUserId(user_id);
		res.status(200).json(customers);
	} catch (error) {
		next(error);
	}
};

//get a customer by id and user id
exports.getCustomerByIdAndUserId = async (req, res, next) => {
	const user_id = req.user.user_id;
	const { account_id } = req.params;
	try {
		const customer = await Customer.getCustomerByIdAndUserId(
			user_id,
			account_id
		);
		res.status(200).json(customer);
	} catch (error) {
		next(error);
	}
};

exports.createUserCustomer = async (req, res, next) => {
	const user_id = req.user.user_id;
	const data = req.body;
	try {
		const { insertId } = await Customer.createCustomerByUserId(
			user_id,
			data
		);
		const customer = await Customer.getCustomerByIdAndUserId(
			user_id,
			insertId
		);
		res.status(201).json(customer);
	} catch (error) {
		next(error);
	}
};

exports.updateUserCustomer = async (req, res, next) => {
	const user_id = req.user.user_id;
	// const { account_id } = req.params;
	const data = req.body;
	try {
		await Customer.updateCustomerByUserId(user_id, data);
		const customer = await Customer.getCustomerByIdAndUserId(
			user_id,
			data.account_id
		);
		res.status(201).json(customer);
	} catch (error) {
		next(error);
	}
};

exports.deleteUserCustomer = async (req, res, next) => {
	const user_id = req.user.user_id;
	const { account_id } = req.params;
	try {
		const result = await Customer.deleteCustomerByUserId(
			user_id,
			account_id
		);
		res.status(201).json({ message: "Customer deleted successfully" });
	} catch (error) {
		next(error);
	}
};

exports.getCustomerBalance = async (req, res, next) => {
	const user_id = req.user.user_id;
	const { account_id, start, end } = req.params;
	try {
		const balance = await Accounts.getAccountDetailsById(
			user_id,
			account_id,
			start,
			end
		);
		res.status(200).json(balance);
	} catch (error) {
		next(error);
	}
};

exports.getCustomerLatestPurchases = async (req, res, next) => {
	const user_id = req.user.user_id;
	const { account_id } = req.params;
	try {
		const purchases = await Customer.getCustomerLatestPurchases(
			user_id,
			account_id
		);
		res.status(200).json(purchases);
	} catch (error) {
		next(error);
	}
};

exports.getCustomerTotalBalance = async (req, res, next) => {
	const user_id = req.user.user_id;
	const { account_id } = req.params;
	try {
		const balance = await Customer.getCustomerTotalBalance(
			user_id,
			account_id
		);
		res.status(200).json({ account_id, ...balance });
	} catch (error) {
		next(error);
	}
};
