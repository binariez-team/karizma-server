const DeliverInvoice = require("../models/DeliverModel");

// GET /deliver/recipients — { database_id, database_name } rows, the same for every
// role. Also answers the deprecated /deliver/users and /user-deliver/users, so older
// web/Electron builds get the same safe list (no admin tenant) as the new screen.
exports.getRecipients = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const recipients = await DeliverInvoice.getRecipients(database_id);
        res.status(200).send(recipients);
    } catch (error) {
        next(error);
    }
};

// Who may see a recipient's quantities on the deliver screen. Admin only for now: it
// shows another tenant's stock, which users and staff otherwise never see. To open it
// to users later, widen this one check (the client's DeliverService.canSeeRecipientStock
// is the matching switch); getRecipientStock still limits every caller to tenants it
// may deliver to.
const canSeeRecipientStock = (user) => user?.user_type === "admin";

// GET /deliver/recipients/:database_id/stock — [{ product_id, quantity }]
exports.getRecipientStock = async (req, res, next) => {
    try {
        // before anything else: refused callers never reach the database
        if (!canSeeRecipientStock(req.user)) {
            return res
                .status(403)
                .send({ message: "You don't have permission to do this" });
        }
        const stock = await DeliverInvoice.getRecipientStock(
            req.params.database_id,
            req.user.database_id,
        );
        res.status(200).send(stock);
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
