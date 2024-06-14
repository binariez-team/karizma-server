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
