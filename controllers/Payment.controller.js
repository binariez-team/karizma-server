const Payment = require("../models/PaymentModel");

exports.addCustomerPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const paymentData = req.body;
        const payment_id = await Payment.addCustomerPayment(
            database_id,
            paymentData
        );

        const result = await Payment.fetchPaymentById(payment_id);

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.editCustomerPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const paymentData = req.body;
        await Payment.editCustomerPayment(database_id, paymentData);

        const result = await Payment.fetchPaymentById(paymentData.journal_id);

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.deletePayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const payment_id = req.params.payment_id;
        const result = await Payment.deletePayment(database_id, payment_id);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.addSupplierPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const paymentData = req.body;
        const result = await Payment.addSupplierPayment(
            database_id,
            paymentData
        );
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.editSupplierPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const paymentData = req.body;
        const result = await Payment.editSupplierPayment(
            database_id,
            paymentData
        );
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};
