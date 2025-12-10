const UserProduct = require("../models/UserStockModel");

exports.getAllProducts = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const rows = await UserProduct.getAll(database_id);
        res.status(200).json(rows);
    } catch (err) {
        next(err);
    }
};

exports.getProductById = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const product_id = req.params.id;
        const [product] = await UserProduct.getById(database_id, product_id);
        res.status(200).json(product);
    } catch (err) {
        next(err);
    }
};

exports.updateProduct = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const product_id = req.params.id;
        const prices = req.body;
        await UserProduct.update(database_id, product_id, prices);
        const [updatedProduct] = await UserProduct.getById(
            database_id,
            product_id
        );

        res.status(200).json(updatedProduct);
    } catch (err) {
        next(err);
    }
};

exports.disposeProducts = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const info = req.body.info;
        const products = req.body.products;
        const result = await UserProduct.dispose(database_id, info, products);
        res.status(204).json(result);
    } catch (err) {
        next(err);
    }
};

exports.deleteDispose = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const dispose_id = req.params.id;
        await UserProduct.deleteDispose(database_id, dispose_id);
        res.status(204).json();
    } catch (err) {
        next(err);
    }
};

exports.updateDispose = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const info = req.body.info;
        const products = req.body.products;
        await UserProduct.updateDispose(database_id, info, products);
        res.status(204).json();
    } catch (err) {
        next(err);
    }
};
