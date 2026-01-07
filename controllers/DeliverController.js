const DeliverInvoice = require("../models/DeliverModel");
const User = require("../models/UserModel");

exports.getUsers = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const users = await User.getUserDatabases(database_id);
        res.status(200).send(users);
    } catch (error) {
        next(error);
    }
};

exports.createDeliverInvoice = async (req, res, next) => {
    try {
        const io = req.io;
        const fromDatabase = req.user;
        const { order, items } = req.body;

        await DeliverInvoice.create(order, items, fromDatabase);
        // const [toDatabase] = await User.getById(order.database_id);
        io.emit("deliverAdded", order.database_id);
        res.status(201).send({
            message: "Order created successfully!",
        });
    } catch (error) {
        next(error);
    }
};

exports.updateDeliverInvoice = async (req, res, next) => {
    try {
        const user = req.user;
        const { order, items } = req.body;
        await DeliverInvoice.update(order, items, user);
        res.status(200).send({
            message: "Order updated successfully!",
        });
    } catch (error) {
        if (error.message === "approved") {
            return res.status(400).send({
                error: "Order has been approved by user!",
            });
        } else {
            next(error);
        }
    }
};

exports.deleteDeliverInvoice = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { database_id } = req.user;
        await DeliverInvoice.delete(id, database_id);
        res.status(200).send({
            message: "Order deleted successfully!",
        });
    } catch (error) {
        if (error.message === "approved") {
            return res.status(400).send({
                error: "Order has been approved by user!",
            });
        } else {
            next(error);
        }
    }
};
