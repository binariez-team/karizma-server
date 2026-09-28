const ReturnModel = require("../models/ReturnModel");

// Every returned line must bring back a positive quantity: the model books it as a
// RETURN stock movement, so a negative line would REMOVE stock and post a negative
// credit. The clients block it — this is the server's own check.
const invalidQuantity = (items) =>
    Array.isArray(items) &&
    items.some((item) => {
        const qty = Number(item?.quantity);
        // whole units: the quantity columns are INT, so 0.4 would be stored as 0
        // while the line total is still computed from 0.4
        return !Number.isInteger(qty) || qty < 1;
    });

exports.addReturn = async (req, res, next) => {
    const { database_id } = req.user;
    const order = req.body.invoice;
    const payment = req.body.payment;
    const items = order.items;
    delete order.items;
    if (invalidQuantity(items)) {
        return res
            .status(400)
            .send({ message: "Every item needs a whole quantity of 1 or more" });
    }

    try {
        const result = await ReturnModel.addReturn(
            database_id,
            order,
            items,
            payment
        );
        const new_order = await ReturnModel.getAddedOrderById(
            result.order,
            database_id
        );
        res.status(201).json(new_order);
    } catch (error) {
        next(error);
    }
};

exports.editReturn = async (req, res, next) => {
    const order = req.body;
    const items = order.items;
    delete order.items;
    if (invalidQuantity(items)) {
        return res
            .status(400)
            .send({ message: "Every item needs a whole quantity of 1 or more" });
    }
    const { database_id } = req.user;

    try {
        const result = await ReturnModel.editReturn(database_id, order, items);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.deleteReturn = async (req, res, next) => {
    const { database_id } = req.user;
    const order_id = req.params.order_id;

    try {
        await ReturnModel.deleteReturn(database_id, order_id);
        res.status(200).json({ message: "Order deleted successfully" });
    } catch (error) {
        next(error);
    }
};
