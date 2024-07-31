const UserProduct = require("../models/UserStockModel");

exports.getAllProducts = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const rows = await UserProduct.getAll(user_id);
		res.status(200).json(rows);
	} catch (err) {
		next(err);
	}
};

exports.getProductById = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const product_id = req.params.id;
		const [product] = await UserProduct.getById(user_id, product_id);
		res.status(200).json(product);
	} catch (err) {
		next(err);
	}
};

exports.updateProduct = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const product_id = req.params.id;
		const prices = req.body;
		await UserProduct.update(user_id, product_id, prices);
		const [updatedProduct] = await UserProduct.getById(user_id, product_id);

		res.status(200).json(updatedProduct);
	} catch (err) {
		next(err);
	}
};

exports.disposeProducts = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const info = req.body.info;
		const products = req.body.products;
		const result = await UserProduct.dispose(user_id, info, products);
		res.status(204).json(result);
	} catch (err) {
		next(err);
	}
};

exports.deleteDispose = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const dispose_id = req.params.id;
		await UserProduct.deleteDispose(user_id, dispose_id);
		res.status(204).json();
	} catch (err) {
		next(err);
	}
};

exports.updateDispose = async (req, res, next) => {
	try {
		const user_id = req.user.user_id;
		const info = req.body.info;
		const products = req.body.products;
		await UserProduct.updateDispose(user_id, info, products);
		res.status(204).json();
	} catch (err) {
		next(err);
	}
};
