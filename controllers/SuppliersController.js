const e = require("express");
const Supplier = require("../models/SuppliersModel");

// get suppliers
exports.getAllSuppliers = async (req, res) => {
  try {
    const suppliers = await Supplier.getAllSuppliers();
    res.status(200).json(suppliers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// get supplier by id
exports.getSupplierById = async (req, res) => {
  const id = req.params.id;
  try {
    const supplier = await Supplier.getSupplierById(id);
    res.status(200).json(supplier);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// create supplier
exports.createSupplier = async (req, res) => {
  const data = req.body;
  try {
    const { insertId } = await Supplier.createSupplier(data);
    const supplier = await Supplier.getSupplierById(insertId);
    res
      .status(201)
      .json({ message: "Supplier created successfully", supplier });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// update supplier
exports.updateSupplier = async (req, res) => {
  const id = req.params.id;
  const data = req.body;
  try {
    const result = await Supplier.updateSupplier(id, data);
    const supplier = await Supplier.getSupplierById(id);
    res
      .status(201)
      .json({ message: "Supplier updated successfully", supplier });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// delete supplier
exports.deleteSupplier = async (req, res) => {
  const id = req.params.id;
  try {
    const result = await Supplier.deleteSupplier(id);
    res.status(201).json({ message: "Supplier deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
