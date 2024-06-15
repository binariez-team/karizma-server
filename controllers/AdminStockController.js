const Product = require("../models/AdminStockModel");

exports.getAllProducts = async (req, res, next) => {
	try {
		let products = await Product.getAll();
		res.status(200).send(products);
	} catch (error) {
		next(error);
	}
};

exports.createProduct = async (req, res, next) => {
	let data = req.body;
	let user = req.user;
	delete data.product_id;
	try {
		let result = await Product.create(data, user);
		let [createdProduct] = await Product.getById(result.insertId);
		res.status(201).send(createdProduct);
	} catch (error) {
		next(error);
	}
};

exports.updateProduct = async (req, res, next) => {
	let product = req.body;
	let user = req.user;
	try {
		await Product.update(product, user);
		let [updatedProduct] = await Product.getById(product.product_id);
		res.status(201).send(updatedProduct);
	} catch (error) {
		next(error);
	}
};

exports.deleteProduct = async (req, res, next) => {
	let product_id = req.params.id;
	try {
		await Product.delete(product_id);
		res.status(202).json({
			message: "Item has been deleted successfully!",
		});
	} catch (error) {
		next(error);
	}
};
