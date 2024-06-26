const Product = require("../models/AdminStockModel");
const UserProduct = require("../models/UserStockModel");

exports.getAllProducts = async (req, res, next) => {
	let user = req.user;
	try {
		let products = await Product.getAll(user);
		res.status(200).send(products);
	} catch (error) {
		next(error);
	}
};

exports.createProduct = async (req, res, next) => {
	const io = req.io;
	const data = req.body;
	const user = req.user;
	delete data.product_id;
	try {
		const result = await Product.create(data, user);
		const [createdProduct] = await Product.getById(result.insertId);
		io.emit("productAdded", createdProduct.product_name);
		res.status(201).send(createdProduct);
	} catch (error) {
		next(error);
	}
};

exports.updateProduct = async (req, res, next) => {
	const io = req.io;
	const product = req.body;
	const user = req.user;
	try {
		await Product.update(product, user);
		const [updatedProduct] = await Product.getById(product.product_id);

		// socket to push update
		io.emit("productUpdated");

		res.status(201).send(updatedProduct);
	} catch (error) {
		next(error);
	}
};

exports.deleteProduct = async (req, res, next) => {
	const product_id = req.params.id;
	try {
		await Product.delete(product_id);
		res.status(202).json({
			message: "Item has been deleted successfully!",
		});
	} catch (error) {
		next(error);
	}
};
