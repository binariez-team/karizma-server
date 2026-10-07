const Quotation = require("../models/QuotationModel");
const { QuotationError, parseQuotation, parseSearch, isId } = Quotation;
const { actorId } = require("../models/OrderActors");

// Every logged-in user of the tenant may list, save, edit and delete quotations
// (mounted behind `auth` only — no permission flag): they move no stock or money.
// Everything is scoped by the token's database_id; another tenant's quotation, a
// deleted one and a malformed id all get the same 404.

const NOT_FOUND = { message: "Quotation not found" };

// Expected refusals (400/404/409) answer with { message, ...extra }; anything else
// goes to the global error handler.
const fail = (error, res, next) =>
    error instanceof QuotationError
        ? res.status(error.statusCode).json(error.body)
        : next(error);

// POST /quotations — save the sell screen's cart as a quotation. 201 with the header.
exports.create = async (req, res, next) => {
    try {
        const data = parseQuotation(req.body);
        if (data.error) return fail(data.error, res, next);

        const { database_id } = req.user;
        const quotation_id = await Quotation.create(
            database_id,
            actorId(req.user),
            data,
        );
        const quotation = await Quotation.getById(quotation_id, database_id);
        res.status(201).json(quotation);
    } catch (error) {
        fail(error, res, next);
    }
};

// POST /quotations/search — headers only, newest first
exports.search = async (req, res, next) => {
    try {
        const criteria = parseSearch(req.body);
        if (criteria.error) return fail(criteria.error, res, next);

        const rows = await Quotation.search(req.user.database_id, criteria);
        res.status(200).json(rows);
    } catch (error) {
        fail(error, res, next);
    }
};

// GET /quotations/:id — one header
exports.getById = async (req, res, next) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json(NOT_FOUND);
        const quotation = await Quotation.getById(
            Number(req.params.id),
            req.user.database_id,
        );
        if (!quotation) return res.status(404).json(NOT_FOUND);
        res.status(200).json(quotation);
    } catch (error) {
        fail(error, res, next);
    }
};

// GET /quotations/:id/items — its lines, fetched on demand like the sales history
exports.getItems = async (req, res, next) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json(NOT_FOUND);
        const items = await Quotation.getItems(
            Number(req.params.id),
            req.user.database_id,
        );
        if (!items) return res.status(404).json(NOT_FOUND);
        res.status(200).json(items);
    } catch (error) {
        fail(error, res, next);
    }
};

// PUT /quotations/:id — replace customer, price type and lines of an open quotation
exports.update = async (req, res, next) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json(NOT_FOUND);
        const data = parseQuotation(req.body);
        if (data.error) return fail(data.error, res, next);

        const { database_id } = req.user;
        const quotation_id = Number(req.params.id);
        await Quotation.update(
            quotation_id,
            database_id,
            actorId(req.user),
            data,
        );
        const quotation = await Quotation.getById(quotation_id, database_id);
        res.status(200).json(quotation);
    } catch (error) {
        fail(error, res, next);
    }
};

// DELETE /quotations/:id — soft delete
exports.remove = async (req, res, next) => {
    try {
        if (!isId(req.params.id)) return res.status(404).json(NOT_FOUND);
        await Quotation.remove(Number(req.params.id), req.user.database_id);
        res.status(200).json({ message: "Quotation deleted successfully" });
    } catch (error) {
        fail(error, res, next);
    }
};
