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
	let product = req.body;
	delete product.product_id;
	try {
		let result = await Product.create(product);
		let [createdProduct] = await Product.getById(result.insertId);
		res.status(201).send(createdProduct);
	} catch (error) {
		next(error);
	}
};
