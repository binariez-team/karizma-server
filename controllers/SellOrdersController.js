const SellOrders = require("../models/SellOrdersModel");

// Every line of a sale must move a positive quantity. The model
// books `-quantity` as the SALE stock movement, so a negative line (e.g. a "-2*CODE"
// scan) would ADD stock and post a negative total; a zero line books nothing but
// still shows on the invoice. The clients block both — this is the server's own check.
const invalidQuantity = (items) =>
    Array.isArray(items) &&
    items.some((item) => {
        const qty = Number(item?.quantity);
        // whole units: the quantity columns are INT, so 0.4 would be stored as 0
        // while the line total is still computed from 0.4
        return !Number.isInteger(qty) || qty < 1;
    });
exports.addOrder = async (req, res, next) => {
    try {
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
        if (invalidQuantity(items)) {
            return res
                .status(400)
                .send({ message: "Every item needs a whole quantity of 1 or more" });
        }
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
