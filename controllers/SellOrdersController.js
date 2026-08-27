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
        // A cash invoice carries its tender split alongside the invoice. Accept the new
        // { invoice, payment } envelope, and fall back to the legacy flat body so an
        // older client keeps working for debt invoices.
        const order = req.body.invoice ?? req.body;
        const payment = req.body.payment ?? null;
        const items = order.items;
        delete order.items;
        const { database_id } = req.user;

        const order_id = await SellOrders.editOrder(
            order,
            items,
            database_id,
            payment,
        );
        const new_order = await SellOrders.getAddedOrderById(
            order_id,
            database_id,
        );
        res.status(201).json(new_order);
    } catch (error) {
        next(error);
    }
};

// current cash/whish split of an invoice, so the edit screen can pre-fill it
exports.getOrderPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const result = await SellOrders.getOrderPayment(
            req.params.id,
            database_id,
        );
        res.status(200).json(result);
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
