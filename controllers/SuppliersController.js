const Supplier = require("../models/SuppliersModel");
const Accounts = require("../models/AccountsModel");

// get suppliers
exports.getAllSuppliers = async (req, res) => {
    try {
        const { database_id } = req.user;
        const suppliers = await Supplier.getAllSuppliers(database_id);
        res.status(200).json(suppliers);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// get supplier by id
exports.getSupplierById = async (req, res) => {
    const id = req.params.id;
    try {
        const { database_id } = req.user;
        const supplier = await Supplier.getSupplierById(id, database_id);
        res.status(200).json(supplier);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// create supplier
exports.createSupplier = async (req, res) => {
    const data = req.body;
    try {
        const { database_id } = req.user;
        const { insertId } = await Supplier.createSupplier(data, database_id);
        const supplier = await Supplier.getSupplierById(insertId);
        res.status(201).json({
            message: "Supplier created successfully",
            supplier,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// update supplier
exports.updateSupplier = async (req, res) => {
    const id = req.params.id;
    const data = req.body;
    try {
        const { database_id } = req.user;
        const result = await Supplier.updateSupplier(id, data, database_id);
        const supplier = await Supplier.getSupplierById(id);
        res.status(201).json({
            message: "Supplier updated successfully",
            supplier,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// delete supplier
exports.deleteSupplier = async (req, res) => {
    const id = req.params.id;
    try {
        const { database_id } = req.user;
        const result = await Supplier.deleteSupplier(id, database_id);
        res.status(201).json({ message: "Supplier deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

//get supplier transactions by user id
exports.getSupplierBalance = async (req, res, next) => {
    const user_id = req.user.user_id;
    const { account_id, start, end } = req.params;
    try {
        const balance = await Accounts.getAccountDetailsById(
            user_id,
            account_id,
            start,
            end,
        );
        res.status(200).json(balance);
    } catch (error) {
        next(error);
    }
};

//get supplier total balance
exports.getSupplierTotalBalance = async (req, res, next) => {
    const { database_id } = req.user;
    const { id } = req.params;
    try {
        const balance = await Supplier.getSupplierTotalBalance(id, database_id);
        res.status(200).json({ id, ...balance });
    } catch (error) {
        next(error);
    }
};

// add manual supplier debt
exports.addManualDebt = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        let data = req.body;
        const result = await Supplier.addManualDebt(database_id, data);
        res.status(201).send(result);
    } catch (error) {
        next(error);
    }
};
