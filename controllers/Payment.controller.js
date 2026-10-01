const Payment = require("../models/PaymentModel");

// One answer for a missing id, another tenant's voucher, a deleted one or a voucher
// that is not a payment (invoice, return, manual debt correction...), so ids cannot
// be probed.
const PAYMENT_NOT_FOUND = { message: "Payment not found" };

// Ids come from the URL or the JSON body; mysql2 expands an object bound to `?` into
// `key = value` SQL, so only a positive integer is let through to the queries.
const toId = (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// The same expansion applies to the other body values bound into SET/VALUES: an
// object `amount` would let the body write any voucher column (type, id, tenant).
// A payment must also be positive: a negative one raises the customer's debt,
// which is a manual debt correction (correct_debt), not a payment. Normalizes
// paymentData in place; returns an error message, or null when it is valid.
const isScalar = (value) =>
    typeof value === "string" || typeof value === "number";
const checkPaymentBody = (paymentData, { moneyAccount }) => {
    // Edits echo total_value back, which mysql2 returns as a DECIMAL string ("75.00").
    const amount = isScalar(paymentData.amount)
        ? Number(paymentData.amount)
        : NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
        return "Invalid amount";
    }
    paymentData.amount = amount;

    if (moneyAccount) {
        if (!isScalar(paymentData.money_account)) {
            return "Invalid money account";
        }
        paymentData.money_account = String(paymentData.money_account);
    }

    const { reference_number } = paymentData;
    if (reference_number != null && !isScalar(reference_number)) {
        return "Invalid reference number";
    }
    return null;
};

exports.addCustomerPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const paymentData = req.body;
        const invalid = checkPaymentBody(paymentData, { moneyAccount: true });
        if (invalid) {
            return res.status(400).json({ message: invalid });
        }
        paymentData.account_id = toId(paymentData.account_id);
        const payment_id =
            paymentData.account_id &&
            (await Payment.addCustomerPayment(database_id, paymentData));
        if (!payment_id) {
            return res.status(404).json({ message: "Customer not found" });
        }

        const result = await Payment.fetchPaymentById(database_id, payment_id);

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.editCustomerPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const paymentData = req.body;
        const invalid = checkPaymentBody(paymentData, { moneyAccount: true });
        if (invalid) {
            return res.status(400).json({ message: invalid });
        }
        paymentData.journal_id = toId(paymentData.journal_id);
        const updated =
            paymentData.journal_id &&
            (await Payment.editCustomerPayment(database_id, paymentData));
        if (!updated) {
            return res.status(404).json(PAYMENT_NOT_FOUND);
        }

        const result = await Payment.fetchPaymentById(
            database_id,
            paymentData.journal_id,
        );

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.deletePayment = async (req, res, next) => {
    try {
        const { database_id, user_type } = req.user;
        const payment_id = toId(req.params.payment_id);
        // Customer payments are deleted from payment history by any user; supplier
        // payments are an admin feature, like the rest of /suppliers.
        const descriptions =
            user_type === "admin"
                ? [Payment.CUSTOMER_PAYMENT, Payment.SUPPLIER_PAYMENT]
                : [Payment.CUSTOMER_PAYMENT];
        const deleted =
            payment_id &&
            (await Payment.deletePayment(database_id, payment_id, descriptions));
        if (!deleted) {
            return res.status(404).json(PAYMENT_NOT_FOUND);
        }
        res.status(200).json();
    } catch (error) {
        next(error);
    }
};

exports.addSupplierPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const paymentData = req.body;
        const invalid = checkPaymentBody(paymentData, { moneyAccount: false });
        if (invalid) {
            return res.status(400).json({ message: invalid });
        }
        paymentData.account_id = toId(paymentData.account_id);
        const created =
            paymentData.account_id &&
            (await Payment.addSupplierPayment(database_id, paymentData));
        if (!created) {
            return res.status(404).json({ message: "Supplier not found" });
        }
        res.status(200).json();
    } catch (error) {
        next(error);
    }
};

exports.editSupplierPayment = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const paymentData = req.body;
        const invalid = checkPaymentBody(paymentData, { moneyAccount: false });
        if (invalid) {
            return res.status(400).json({ message: invalid });
        }
        paymentData.journal_id = toId(paymentData.journal_id);
        const updated =
            paymentData.journal_id &&
            (await Payment.editSupplierPayment(database_id, paymentData));
        if (!updated) {
            return res.status(404).json(PAYMENT_NOT_FOUND);
        }
        res.status(200).json();
    } catch (error) {
        next(error);
    }
};
