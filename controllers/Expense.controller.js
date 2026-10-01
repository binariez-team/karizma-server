const moment = require("moment-timezone");
const Expense = require("../models/ExpenseModel");

// One answer for a missing id, another tenant's voucher, a deleted one or a voucher
// that is not an expense (invoice, payment, transfer, manual debt correction...), so
// ids cannot be probed.
const EXPENSE_NOT_FOUND = { message: "Expense not found." };

// Ids come from the URL or the JSON body; mysql2 expands an object bound to `?` into
// `key = value` SQL, so only a positive integer is let through to the queries.
const toId = (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// The same expansion applies to the body values bound into SET/VALUES: an object
// total_value would let the body write any voucher column (tenant, number, type).
const isScalar = (value) =>
    typeof value === "string" || typeof value === "number";

// journal_vouchers.journal_description and journal_items.reference_number are
// varchar(255) utf8mb3, which cannot store a 4-byte character (emoji): either would
// fail the INSERT with a 500 instead of a 400.
const TEXT_MAX_LENGTH = 255;
const FOUR_BYTE_CHAR = /[\u{10000}-\u{10FFFF}]/u;
// total_value and the item debit/credit are DECIMAL(10,2), which keeps cents only:
// MySQL would store 0.004 as a 0.00 expense and reject 99999999.995 as out of range.
const MAX_CENTS = 9999999999;

// journal_description values the server itself writes or keys on (models/*.js).
// Reports sum and payment history lists vouchers by 'Payment Received' / 'Supplier
// Payment', statements branch on 'Invoice' / 'Return' / 'Manual Transaction' /
// 'Supply', the transfer history filters on 'Transfer', and the statements add a
// synthetic 'Initial Balance' row. An expense carrying one of them would be counted,
// listed or handled as that kind of voucher.
const RESERVED_DESCRIPTIONS = [
    "Payment Received",
    "Supplier Payment",
    "Payment Returned",
    "Invoice",
    "Return",
    "Supply",
    "Transfer",
    "Self Transfer",
    "Manual Transaction",
    "Initial Balance",
];

// Latin letters with a stroke or bar. NFKD keeps them whole, but Unicode collation
// weighs some of them (ł, đ, ø...) as the plain letter at the level the column's
// collation compares, so 'Payment Receiveđ' could still be summed as 'Payment Received'.
const LETTER_FOLDS = {
    ł: "l", đ: "d", ø: "o", ħ: "h", ŧ: "t", ƀ: "b", ƶ: "z", ɨ: "i", ʉ: "u",
    ɍ: "r", ɏ: "y", ǥ: "g", ɉ: "j", ȼ: "c", ɇ: "e",
};
const STROKE_LETTER = new RegExp(`[${Object.keys(LETTER_FOLDS).join("")}]`, "g");

// The column's utf8mb3_unicode_ci collation compares case- and accent-insensitively
// and ignores trailing spaces, so 'payment receivéd ' matches 'Payment Received' in
// those WHERE clauses. Fold the same way (plus compatibility forms, invisible and
// ignorable characters, runs of whitespace and stroke letters) so a look-alike is
// refused too. Folding more than MySQL does only refuses an odd description.
const foldLabel = (text) =>
    text
        .normalize("NFKD")
        .replace(/\s+/g, " ")
        .replace(/[\p{M}\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, "")
        .replace(/ +/g, " ")
        .trim()
        .toUpperCase()
        .toLowerCase()
        .replace(STROKE_LETTER, (c) => LETTER_FOLDS[c]);
const RESERVED_BY_FOLD = new Map(
    RESERVED_DESCRIPTIONS.map((label) => [foldLabel(label), label]),
);
// Catch-all for any other letter Unicode collation treats as the base letter. The
// locale is fixed because a default like 'da' would keep 'ø' apart from 'o'.
const BASE_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });
const reservedLabelOf = (description) => {
    const folded = foldLabel(description);
    return (
        RESERVED_BY_FOLD.get(folded) ??
        [...RESERVED_BY_FOLD].find(
            ([label]) => BASE_COLLATOR.compare(folded, label) === 0,
        )?.[1]
    );
};

// Normalizes the expense body in place; returns an error message, or null when it
// is valid.
const checkExpenseBody = (data, { create }) => {
    if (typeof data.journal_description !== "string") {
        return "Invalid description";
    }
    const description = data.journal_description.trim();
    if (!description || description.length > TEXT_MAX_LENGTH) {
        return "Invalid description";
    }
    if (FOUR_BYTE_CHAR.test(description)) {
        return "Invalid description: emoji and similar symbols are not supported";
    }
    const reserved = reservedLabelOf(description);
    if (reserved) {
        return `"${reserved}" is reserved for system entries, please use another description`;
    }
    data.journal_description = description;

    // The edit dialog echoes total_value back as mysql2's DECIMAL string ("12.50").
    // Checked and stored in cents, so what is written is what was validated.
    const amount = isScalar(data.total_value) ? Number(data.total_value) : NaN;
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || cents < 1 || cents > MAX_CENTS) {
        return "Invalid amount";
    }
    data.total_value = cents / 100;

    const moneyAccount = isScalar(data.money_account)
        ? String(data.money_account)
        : null;
    if (!Expense.MONEY_ACCOUNTS.includes(moneyAccount)) {
        return "Invalid money account";
    }
    data.money_account = moneyAccount;

    const { reference_number } = data;
    if (
        reference_number != null &&
        (!isScalar(reference_number) ||
            String(reference_number).length > TEXT_MAX_LENGTH ||
            FOUR_BYTE_CHAR.test(String(reference_number)))
    ) {
        return "Invalid reference number";
    }

    // Only create reads payment_date; the dialog does not send it, which means "now".
    if (create) {
        if (data.payment_date == null) {
            data.payment_date = undefined;
        } else if (
            !isScalar(data.payment_date) ||
            !moment(data.payment_date).isValid()
        ) {
            return "Invalid date";
        }
    }
    return null;
};

exports.getExpenseDetails = async (req, res, next) => {
    try {
        let { expense, start, end } = req.body;
        const { database_id } = req.user;
        // start/end are bound as `?` values, where an object would expand into SQL.
        if ([expense, start, end].some((v) => v != null && !isScalar(v))) {
            return res.status(400).json({ message: "Invalid search" });
        }
        const expenses = await Expense.getExpenseDetails(
            expense,
            start,
            end,
            database_id
        );
        res.status(200).send(expenses);
    } catch (err) {
        next(err);
    }
};

exports.getExpenseAccounts = async (req, res, next) => {
    try {
        const accounts = await Expense.getExpenseAccounts();
        res.json(accounts);
    } catch (err) {
        next(err);
    }
};

// create
exports.createExpense = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const data = req.body;
        const invalid = checkExpenseBody(data, { create: true });
        if (invalid) {
            return res.status(400).json({ message: invalid });
        }
        await Expense.createExpense(database_id, data);
        res.json({ message: "Expense created successfully" });
    } catch (err) {
        next(err);
    }
};

// update
exports.updateExpense = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        // The URL names the expense; the body used to, and was trusted over it.
        const journal_id = toId(req.params.journal_id);
        if (!journal_id) {
            return res.status(404).json(EXPENSE_NOT_FOUND);
        }
        const data = req.body;
        const invalid = checkExpenseBody(data, { create: false });
        if (invalid) {
            return res.status(400).json({ message: invalid });
        }
        // The dialog sends the same id in both places. A different one means the
        // caller is confused about which expense it is editing, so refuse rather than
        // guess which of the two it meant.
        if (data.journal_id != null && toId(data.journal_id) !== journal_id) {
            return res
                .status(400)
                .json({ message: "Expense id does not match the URL" });
        }
        const updated = await Expense.updateExpense(
            database_id,
            journal_id,
            data,
        );
        if (!updated) {
            return res.status(404).json(EXPENSE_NOT_FOUND);
        }
        res.json({ message: "Expense updated successfully" });
    } catch (err) {
        next(err);
    }
};

// delete
exports.deleteExpense = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        const journal_id = toId(req.params.journal_id);
        if (!journal_id) {
            return res.status(404).json(EXPENSE_NOT_FOUND);
        }

        const result = await Expense.deleteExpense(database_id, journal_id);

        // Never report success for a delete that removed nothing: a miss means the
        // voucher does not exist, belongs to another database_id, is deleted or is not
        // an expense, and all of those are "not found" from this caller's point of view.
        if (!result || result.deleted === 0) {
            return res.status(404).json(EXPENSE_NOT_FOUND);
        }

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};
