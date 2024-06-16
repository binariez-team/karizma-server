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
