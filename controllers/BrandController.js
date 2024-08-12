const Brand = require("../models/BrandModel");

// get Brands
exports.getBrands = async (req, res, next) => {
	try {
		let brands = await Brand.getAll();
		res.status(200).send(brands);
	} catch (error) {
		next(error);
	}
};

// create Brand
exports.createBrand = async (req, res, next) => {
	let brand = req.body;
	try {
		let result = await Brand.create(brand);
		let createdBrand = await Brand.getById(result.insertId);
		res.status(201).send(createdBrand);
	} catch (error) {
		next(error);
	}
};

// update Brand
exports.updateBrand = async (req, res, next) => {
	let brand = req.body;
	try {
		await Brand.update(brand);
		let updatedBrand = await Brand.getById(brand.brand_id);
		res.status(201).send(updatedBrand);
	} catch (error) {
		next(error);
	}
};

// delete category
exports.deleteBrand = async (req, res, next) => {
	let brand_id = req.params.id;
	try {
		await Brand.delete(brand_id);
		res.status(202).json({
			message: "Brand has been deleted successfully!",
		});
	} catch (error) {
		next(error);
	}
};
