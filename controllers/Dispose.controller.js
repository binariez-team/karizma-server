const Dispose = require("../models/Dispose.model");

exports.createDispose = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const info = {
            total_cost: req.body.total_cost,
            total_count: req.body.total_count,
            products_number: req.body.products_number,
        };
        const items = req.body.items;

        const result = await Dispose.create(database_id, info, items);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};
