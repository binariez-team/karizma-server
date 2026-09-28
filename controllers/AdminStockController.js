const Product = require("../models/AdminStockModel");

exports.getAllProducts = async (req, res, next) => {
    let user = req.user;
    try {
        let products = await Product.getAll(user);
        res.status(200).send(products);
    } catch (error) {
        next(error);
    }
};

exports.createProduct = async (req, res, next) => {
    const io = req.io;
    const data = req.body;
    const user = req.user;
    delete data.product_id;
    try {
        const result = await Product.create(data, user);
        const [createdProduct] = await Product.getById(
            result.insertId,
            user.database_id
        );
        io.emit("productAdded", createdProduct.product_name);
        res.status(201).send(createdProduct);
    } catch (error) {
        next(error);
    }
};

exports.updateProduct = async (req, res, next) => {
    const io = req.io;
    const product = req.body;
    const user = req.user;
    try {
        await Product.update(product, user);
        const [updatedProduct] = await Product.getById(
            product.product_id,
            user.database_id
        );

        // socket to push update
        io.emit("productUpdated");

        res.status(201).send(updatedProduct);
    } catch (error) {
        next(error);
    }
};

exports.updateVisibility = async (req, res, next) => {
    const io = req.io;
    const user = req.user;
    const { product_ids, show_on_sell_page } = req.body;
    try {
        await Product.updateVisibility(user, product_ids, show_on_sell_page);
        io.emit("productUpdated");
        res.status(200).json({ message: "Visibility updated successfully!" });
    } catch (error) {
        next(error);
    }
};

exports.deleteProduct = async (req, res, next) => {
    const product_id = req.params.id;
    try {
        await Product.delete(product_id);
        res.status(202).json({
            message: "Item has been deleted successfully!",
        });
    } catch (error) {
        next(error);
    }
};

exports.addStockCorrection = async (req, res, next) => {
    try {
        // const io = req.io;
        const user = req.user;

        // Build the ledger row from known fields only — updateStock INSERTs it with
        // `SET ?`, so passing req.body through would let a caller pick any
        // transaction_type (SUPPLY, SALE, ...) or attach the row to another document's
        // order_id_fk. This endpoint is reachable by users with edit_stock, not just
        // admins.
        const { product_id_fk, transaction_type, transaction_notes } = req.body;
        const quantity = Number(req.body.quantity);
        if (
            !product_id_fk ||
            !["ADD", "REMOVE"].includes(transaction_type) ||
            !(quantity > 0)
        ) {
            return res.status(400).send({ message: "Invalid stock correction" });
        }

        const data = {
            database_id: user.database_id,
            product_id_fk,
            transaction_type,
            quantity,
            transaction_notes,
        };
        await Product.updateStock(data);

        // fetch updated product
        const [updatedProduct] = await Product.getById(
            data.product_id_fk,
            user.database_id
        );

        // io.emit("productUpdated", [updatedProduct, user]);

        res.status(201).send(updatedProduct);
    } catch (error) {
        next(error);
    }
};
