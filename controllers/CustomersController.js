const Customer = require("../models/CustomersModel");

// get customers
exports.getAllCustomers = async (req, res, next) => {
  try {
    const customers = await Customer.getAllCustomers();
    res.status(200).json(customers);
  } catch (error) {
    next(error);
  }
};

// get customer by id
exports.getCustomerById = async (req, res, next) => {
  const id = req.params.id;
  try {
    const customer = await Customer.getCustomerById(id);
    res.status(200).json(customer);
  } catch (error) {
    next(error);
  }
};

// create customer
exports.createCustomer = async (req, res, next) => {
  const data = req.body;
  try {
    const { insertId } = await Customer.createCustomer(data);
    const customer = await Customer.getCustomerById(insertId);
    res
      .status(201)
      .json({ message: "Customer created successfully", customer });
  } catch (error) {
    next(error);
  }
};

// update customer
exports.updateCustomer = async (req, res, next) => {
  const id = req.params.id;
  const data = req.body;
  try {
    const result = await Customer.updateCustomer(id, data);
    const customer = await Customer.getCustomerById(id);
    res
      .status(201)
      .json({ message: "Customer updated successfully", customer });
  } catch (error) {
    next(error);
  }
};

// delete customer
exports.deleteCustomer = async (req, res, next) => {
  const id = req.params.id;
  try {
    const result = await Customer.deleteCustomer(id);
    res.status(201).json({ message: "Customer deleted successfully" });
  } catch (error) {
    next(error);
  }
};

//customer model related to user//
// get customers by user id
exports.getCustomersByUserId = async (req, res, next) => {
  const user_id = req.params.user_id;
  try {
    const customers = await Customer.getCustomersByUserId(user_id);
    res.status(200).json(customers);
  } catch (error) {
    next(error);
  }
};

//get a customer by id and user id
exports.getCustomerByIdAndUserId = async (req, res, next) => {
  const { user_id, account_id } = req.params;
  try {
    const customer = await Customer.getCustomerByIdAndUserId(
      user_id,
      account_id
    );
    res.status(200).json(customer);
  } catch (error) {
    next(error);
  }
};
