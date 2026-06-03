const SellOrders = require("../models/SellOrdersModel");
exports.addOrder = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const order = req.body.invoice;
        const payment = req.body.payment;
        const items = order.items;
        delete order.items;

        order.database_id = database_id;

        const result = await SellOrders.addOrder(
            order,
            items,
            database_id,
            payment,
        );
        const new_order = await SellOrders.getAddedOrderById(
            result.order,
            database_id,
        );
        res.status(201).json(new_order);
    } catch (error) {
        next(error);
    }
};
exports.editOrder = async (req, res, next) => {
    try {
        const order = req.body;
        const items = order.items;
        delete order.items;
        const { database_id } = req.user;

        const result = await SellOrders.editOrder(order, items, database_id);
        const new_order = await SellOrders.getAddedOrderById(
            result.insertId,
            database_id,
        );
        res.status(201).json(new_order);
    } catch (error) {
        next(error);
    }
};
exports.deleteOrder = async (req, res, next) => {
    try {
        const order_id = req.params.id;
        const { database_id } = req.user;
        await SellOrders.deleteOrder(order_id, database_id);
        res.status(200).json({ message: "Order deleted successfully" });
    } catch (error) {
        next(error);
    }
};
