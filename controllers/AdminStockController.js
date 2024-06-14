const Product = require("../models/AdminStockModel");

exports.getAllProducts = async (req, res, next) => {
	try {
		let products = await Product.getAll();
		res.status(200).send(products);
	} catch (error) {
		next(error);
	}
};
