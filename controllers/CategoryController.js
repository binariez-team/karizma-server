const Category = require("../models/CategoryModel");

// get categories
exports.getCategories = async (req, res, next) => {
    try {
        let categories = await Category.getAll();
        res.status(200).send(categories);
    } catch (error) {
        next(error);
    }
};

// create category
exports.createCategory = async (req, res, next) => {
    let category = req.body;
    try {
        let result = await Category.create(category);
        let createdCategory = await Category.getById(result.insertId);
        res.status(201).send(createdCategory);
    } catch (error) {
        next(error);
    }
};

exports.sortCategories = async (req, res, next) => {
    let categories = req.body;
    try {
        await Category.sort(categories);
        let updatedCategories = await Category.getAll();
        res.status(201).send(updatedCategories);
    } catch (error) {
        next(error);
    }
};

// update category
exports.updateCategory = async (req, res, next) => {
    let category = req.body;
    try {
        await Category.update(category);
        let updatedCategory = await Category.getById(category.category_id);
        res.status(201).send(updatedCategory);
    } catch (error) {
        next(error);
    }
};

// delete category
exports.deleteCategory = async (req, res, next) => {
    let category_id = req.params.id;
    try {
        await Category.delete(category_id);
        res.status(202).json({
            message: "Category has been deleted successfully!",
        });
    } catch (error) {
        next(error);
    }
};
