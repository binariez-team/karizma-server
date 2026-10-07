const pool = require("../config/database");
const moment = require("moment-timezone");
const { ACTOR_COLUMNS, actorJoins } = require("./OrderActors");

// Saved quotations: a priced offer to a customer, kept so it can be printed, sent,
// edited and later turned into a real invoice from the sell screen.
//
// A quotation is NOT a sale. Saving, editing or deleting one never touches stock
// (inventory_transactions), journals or balances — only these two tables. It
// becomes a sale only when the converted sell invoice is checked out, through
// the normal POST /sell-orders, which then marks it converted (markConverted).
//
// Migration (run manually, BEFORE deploying the server that uses these tables):
//
// CREATE TABLE quotations (
//     quotation_id INT NOT NULL AUTO_INCREMENT,
//     quotation_number VARCHAR(100) NOT NULL,
//     database_id INT NOT NULL,
//     customer_id INT NOT NULL,
//     quotation_datetime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
//     price_type VARCHAR(50) NULL DEFAULT NULL,
//     total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
//     status ENUM('open','converted') NOT NULL DEFAULT 'open',
//     converted_order_id INT NULL DEFAULT NULL,
//     converted_at DATETIME NULL DEFAULT NULL,
//     created_by_user_id INT NULL DEFAULT NULL,
//     updated_by_user_id INT NULL DEFAULT NULL,
//     is_deleted TINYINT(1) NOT NULL DEFAULT 0,
//     PRIMARY KEY (quotation_id),
//     UNIQUE KEY uq_quotations_number (quotation_number),
//     KEY idx_quotations_db_deleted_datetime (database_id, is_deleted, quotation_datetime),
//     KEY idx_quotations_customer (customer_id)
// ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
//
// CREATE TABLE quotation_items (
//     quotation_item_id INT NOT NULL AUTO_INCREMENT,
//     quotation_id INT NOT NULL,
//     product_id INT NOT NULL,
//     quantity INT NOT NULL,
//     price_type VARCHAR(50) NULL DEFAULT NULL,
//     unit_price DECIMAL(10,2) NOT NULL,
//     total_price DECIMAL(10,2) NOT NULL,
//     PRIMARY KEY (quotation_item_id),
//     KEY idx_quotation_items_quotation (quotation_id),
//     CONSTRAINT fk_quotation_items_quotation FOREIGN KEY (quotation_id)
//         REFERENCES quotations (quotation_id) ON DELETE CASCADE
// ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
//
// - quotations.price_type is the invoice-level price type (the sell screen's "price
//   type" dropdown), so a converted invoice reopens with the same one; each line
//   keeps its own price_type too.
// - UNIQUE quotation_number: numbers are MAX()+1 like every other document, which
//   two simultaneous saves can both pick. The key turns that into a duplicate-key
//   error, and create() retries with the next number.
// - No FK to users/customers/products/sales_orders (soft-deleted rows; old documents
//   must keep naming them). Only the lines hang off their quotation.

const PRICE_TYPES = new Set([
    "latest",
    "unit_price_usd",
    "whole_price_usd",
    "grandwhole_price_usd",
]);
const STATUSES = new Set(["open", "converted"]);

// DECIMAL(10,2) and INT limits: anything larger fails (strict mode) or is clipped
// (non-strict) by MySQL, so it is refused up front with a readable message.
const MAX_CENTS = 9999999999; // 99,999,999.99
const MAX_QTY = 2147483647;

// Raw body ids reach `?`, where mysql2 renders a JSON object as SQL: {"is_deleted":0}
// -> `is_deleted` = 0. Only whole-number ids pass (same rule as SellOrders/Return).
const isId = (v) =>
    (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) &&
    Number.isSafeInteger(Number(v)) &&
    Number(v) > 0;

// A number, or a plain numeric string. `null`, "" and booleans are NOT 0 here —
// Number() would quietly turn them into a free line.
const toNumber = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    return NaN;
};

// Money in integer cents, like SellOrdersModel.editOrder: the columns hold 2
// decimals, and summing cents keeps the header equal to the sum of its lines.
const toCents = (v) => {
    const n = toNumber(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
};
const fromCents = (cents) => cents / 100;

// null (none) or one of the sell screen's price types; undefined when invalid
const toPriceType = (v) => {
    if (v === undefined || v === null || v === "") return null;
    return typeof v === "string" && PRICE_TYPES.has(v) ? v : undefined;
};

// 'YYYY-MM-DD', null when not given, undefined when given but unreadable
const toDate = (v) => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string") return undefined;
    const m = moment(v, moment.ISO_8601);
    return m.isValid() ? m.format("YYYY-MM-DD") : undefined;
};

class QuotationError extends Error {
    constructor(statusCode, message, extra = {}) {
        super(message);
        this.statusCode = statusCode;
        this.body = { message, ...extra };
    }
}
const notFound = () => new QuotationError(404, "Quotation not found");

const bad = (message, extra) => ({ error: new QuotationError(400, message, extra) });

/**
 * Validate a create/edit body: { customer_id, price_type, items: [{ product_id,
 * quantity, unit_price, price_type }] }. Pure — runs before any query, so a refused
 * body writes nothing. Only these keys are read: a quotation number, status,
 * database_id or created_by in the body never reaches the database.
 *
 * Returns { error } or { customer_id, price_type, lines, total_cents }.
 */
const parseQuotation = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body))
        return bad("Invalid quotation");

    if (!isId(body.customer_id))
        return bad("Select a customer for the quotation");

    const price_type = toPriceType(body.price_type);
    if (price_type === undefined) return bad("Invalid price type");

    const items = body.items;
    if (!Array.isArray(items) || items.length === 0)
        return bad("A quotation must have at least one item");

    const lines = [];
    let total_cents = 0;
    for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item))
            return bad("Invalid item");
        if (!isId(item.product_id))
            return bad("Every item needs a valid product");

        // whole units: quantity is INT, so 0.4 would be stored as 0 while the
        // line total was computed from 0.4 (same rule as checkout)
        const quantity = toNumber(item.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY)
            return bad("Every item needs a whole quantity of 1 or more");

        const unit_cents = toCents(item.unit_price);
        if (unit_cents === null || unit_cents > MAX_CENTS)
            return bad("Every item needs a valid price");

        const line_type = toPriceType(item.price_type);
        if (line_type === undefined) return bad("Invalid price type");

        // recomputed here — never the client's line or grand total
        const line_cents = unit_cents * quantity;
        total_cents += line_cents;
        if (line_cents > MAX_CENTS || total_cents > MAX_CENTS)
            return bad("The quotation total is too large");

        lines.push({
            product_id: Number(item.product_id),
            quantity,
            price_type: line_type,
            unit_cents,
            line_cents,
        });
    }

    return {
        customer_id: Number(body.customer_id),
        price_type,
        lines,
        total_cents,
    };
};

/**
 * Validate the list filters (POST /quotations/search). The sales history form
 * names the number field `invoice_number`, so that is accepted as an alias.
 * Returns { error } or { number, customer_id, start_date, end_date, status }.
 */
const parseSearch = (body) => {
    const c = body && typeof body === "object" && !Array.isArray(body) ? body : {};

    const rawNumber = c.quotation_number ?? c.invoice_number;
    let number = null;
    if (rawNumber !== undefined && rawNumber !== null && rawNumber !== "") {
        if (typeof rawNumber !== "string" && typeof rawNumber !== "number")
            return bad("Invalid quotation number");
        number = String(rawNumber).trim() || null;
    }

    let customer_id = null;
    if (c.customer_id !== undefined && c.customer_id !== null && c.customer_id !== "") {
        if (!isId(c.customer_id)) return bad("Invalid customer");
        customer_id = Number(c.customer_id);
    }

    const start_date = toDate(c.start_date);
    const end_date = toDate(c.end_date);
    if (start_date === undefined || end_date === undefined)
        return bad("Invalid date");

    let status = null;
    if (c.status !== undefined && c.status !== null && c.status !== "") {
        if (typeof c.status !== "string" || !STATUSES.has(c.status))
            return bad("Invalid status");
        status = c.status;
    }

    return { number, customer_id, start_date, end_date, status };
};

// One header row — the same shape for the list, the single read, and the
// create/edit responses. converted_invoice_* come from the linked sale.
const HEADER_SELECT = `SELECT
        Q.quotation_id,
        Q.quotation_number,
        Q.customer_id,
        A.name AS customer_name,
        A.phone AS customer_phone,
        A.address AS customer_address,
        Q.quotation_datetime,
        DATE(Q.quotation_datetime) AS quotation_date,
        Q.price_type,
        Q.total_amount,
        (SELECT COALESCE(SUM(QI.quantity), 0) FROM quotation_items QI
            WHERE QI.quotation_id = Q.quotation_id) AS total_quantity,
        Q.status,
        Q.converted_order_id,
        Q.converted_at,
        SO.invoice_number AS converted_invoice_number,
        CASE WHEN Q.converted_order_id IS NOT NULL
            AND (SO.order_id IS NULL OR SO.is_deleted = 1) THEN 1 ELSE 0 END
            AS converted_invoice_deleted,
        Q.created_by_user_id,
        Q.updated_by_user_id,
        ${ACTOR_COLUMNS}
    FROM quotations Q
    LEFT JOIN accounts A ON A.account_id = Q.customer_id
    LEFT JOIN sales_orders SO
        ON SO.order_id = Q.converted_order_id AND SO.database_id = Q.database_id
    ${actorJoins("Q")}`;

// mysql2 hands DECIMAL and SUM() back as strings
const toHeader = (row) => ({
    ...row,
    total_amount: Number(row.total_amount),
    total_quantity: Number(row.total_quantity),
    converted_invoice_deleted: Number(row.converted_invoice_deleted) === 1,
});

// The tenant's own live customer. Checked on every save: the id comes from the body.
const assertCustomer = async (connection, customer_id, database_id) => {
    const [[row]] = await connection.query(
        `SELECT account_id FROM accounts
        WHERE account_id = ? AND database_id = ? AND is_customer = 1 AND is_deleted = 0`,
        [customer_id, database_id],
    );
    if (!row) throw new QuotationError(400, "Customer not found");
};

// Products the tenant can sell: the sell screens list exactly these (a live product
// with an inventory row for this database). Anything else is refused with its ids.
const assertProducts = async (connection, lines, database_id) => {
    const ids = [...new Set(lines.map((l) => l.product_id))];
    const [rows] = await connection.query(
        `SELECT DISTINCT P.product_id FROM products P
        INNER JOIN inventory I ON I.product_id_fk = P.product_id AND I.database_id = ?
        WHERE P.product_id IN (?) AND P.is_deleted = 0`,
        [database_id, ids],
    );
    const found = new Set(rows.map((r) => Number(r.product_id)));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length)
        throw new QuotationError(
            400,
            "Some products are no longer available",
            { product_ids: missing },
        );
};

const insertLines = (connection, quotation_id, lines) =>
    connection.query(
        `INSERT INTO quotation_items (quotation_id, product_id, quantity, price_type, unit_price, total_price) VALUES ?`,
        [
            lines.map((l) => [
                quotation_id,
                l.product_id,
                l.quantity,
                l.price_type,
                fromCents(l.unit_cents),
                fromCents(l.line_cents),
            ]),
        ],
    );

const isDuplicateKey = (error) =>
    error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;

// Errors after which InnoDB may already have rolled back the whole transaction
// (or the connection is gone): carrying on would commit half a sale.
const abortsTransaction = (error) =>
    !!error?.fatal ||
    error?.code === "ER_LOCK_DEADLOCK" ||
    error?.code === "ER_LOCK_WAIT_TIMEOUT";

const now = () => moment().tz("Asia/Beirut").format("YYYY-MM-DD HH:mm:ss");

class Quotation {
    /**
     * Save a quotation. `data` is parseQuotation()'s result; `user_id` the caller
     * (token) recorded as the preparer. Dated now (Beirut, like sales), numbered
     * QUO#### with MAX()+1 like every other document. Returns the new id.
     */
    static async create(database_id, user_id, data) {
        for (let attempt = 1; ; attempt++) {
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();
                await assertCustomer(connection, data.customer_id, database_id);
                await assertProducts(connection, data.lines, database_id);

                const [[{ number }]] = await connection.query(
                    `SELECT IFNULL(MAX(CAST(SUBSTRING(quotation_number, 4) AS UNSIGNED)), 1000) + 1 AS number FROM quotations`,
                );
                const quotation_number = `QUO${number.toString().padStart(4, "0")}`;

                const [result] = await connection.query(
                    `INSERT INTO quotations (quotation_number, database_id, customer_id, quotation_datetime, price_type, total_amount, status, created_by_user_id, updated_by_user_id) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
                    [
                        quotation_number,
                        database_id,
                        data.customer_id,
                        now(),
                        data.price_type,
                        fromCents(data.total_cents),
                        user_id,
                    ],
                );
                await insertLines(connection, result.insertId, data.lines);

                await connection.commit();
                return result.insertId;
            } catch (error) {
                await connection.rollback();
                if (isDuplicateKey(error)) {
                    // another save took the same number first: retry with the next one
                    if (attempt < 3) continue;
                    throw new QuotationError(
                        409,
                        "The quotation could not be numbered, please try again",
                    );
                }
                throw error;
            } finally {
                connection.release();
            }
        }
    }

    /** List (headers only — lines via getItems), newest first. */
    static async search(database_id, criteria) {
        let sql = `${HEADER_SELECT}
            WHERE Q.is_deleted = 0 AND Q.database_id = ?`;
        const params = [database_id];
        if (criteria.number) {
            sql += ` AND Q.quotation_number LIKE ?`;
            params.push(`%${criteria.number}%`);
        }
        if (criteria.customer_id) {
            sql += ` AND Q.customer_id = ?`;
            params.push(criteria.customer_id);
        }
        if (criteria.start_date) {
            sql += ` AND DATE(Q.quotation_datetime) >= ?`;
            params.push(criteria.start_date);
        }
        if (criteria.end_date) {
            sql += ` AND DATE(Q.quotation_datetime) <= ?`;
            params.push(criteria.end_date);
        }
        if (criteria.status) {
            sql += ` AND Q.status = ?`;
            params.push(criteria.status);
        }
        sql += ` ORDER BY Q.quotation_datetime DESC, Q.quotation_id DESC`;

        const [rows] = await pool.query(sql, params);
        return rows.map(toHeader);
    }

    /** One header, or null when it is not this tenant's or is deleted. */
    static async getById(quotation_id, database_id) {
        const [[row]] = await pool.query(
            `${HEADER_SELECT}
            WHERE Q.quotation_id = ? AND Q.database_id = ? AND Q.is_deleted = 0`,
            [quotation_id, database_id],
        );
        return row ? toHeader(row) : null;
    }

    /**
     * The lines of one quotation in entry order, or null when the quotation is not
     * this tenant's or is deleted. product_available says whether the product can
     * still be sold here (the convert flow leaves the others out); LEFT JOIN so a
     * line whose product is gone still shows and the lines still add up.
     */
    static async getItems(quotation_id, database_id) {
        const [[header]] = await pool.query(
            `SELECT quotation_id FROM quotations
            WHERE quotation_id = ? AND database_id = ? AND is_deleted = 0`,
            [quotation_id, database_id],
        );
        if (!header) return null;

        const [rows] = await pool.query(
            `SELECT
                QI.quotation_item_id,
                QI.product_id,
                P.product_name,
                P.sku,
                QI.quantity,
                QI.price_type,
                QI.unit_price,
                QI.total_price,
                CASE WHEN P.product_id IS NOT NULL AND P.is_deleted = 0
                    AND EXISTS (SELECT 1 FROM inventory I
                        WHERE I.product_id_fk = P.product_id AND I.database_id = ?)
                    THEN 1 ELSE 0 END AS product_available
            FROM quotation_items QI
            LEFT JOIN products P ON P.product_id = QI.product_id
            WHERE QI.quotation_id = ?
            ORDER BY QI.quotation_item_id`,
            [database_id, quotation_id],
        );
        return rows.map((r) => ({
            ...r,
            quantity: Number(r.quantity),
            unit_price: Number(r.unit_price),
            total_price: Number(r.total_price),
            product_available: Number(r.product_available) === 1,
        }));
    }

    /**
     * Replace the customer, price type and lines of an open quotation; the caller is
     * recorded as the last editor. Number, date, preparer and status are kept. A
     * converted quotation is refused (409): it already matches an invoice, and the
     * invoice — not the quotation — is what gets edited from then on.
     */
    static async update(quotation_id, database_id, user_id, data) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // FOR UPDATE: serialises two edits, and an edit against the checkout
            // that converts it (markConverted updates the same row)
            const [[row]] = await connection.query(
                `SELECT quotation_id, status FROM quotations
                WHERE quotation_id = ? AND database_id = ? AND is_deleted = 0
                FOR UPDATE`,
                [quotation_id, database_id],
            );
            if (!row) throw notFound();
            if (row.status !== "open")
                throw new QuotationError(
                    409,
                    "This quotation was already converted to an invoice and can no longer be edited",
                );

            await assertCustomer(connection, data.customer_id, database_id);
            await assertProducts(connection, data.lines, database_id);

            await connection.query(
                `DELETE FROM quotation_items WHERE quotation_id = ?`,
                [quotation_id],
            );
            await insertLines(connection, quotation_id, data.lines);
            await connection.query(
                `UPDATE quotations SET customer_id = ?, price_type = ?, total_amount = ?, updated_by_user_id = ?
                WHERE quotation_id = ? AND database_id = ?`,
                [
                    data.customer_id,
                    data.price_type,
                    fromCents(data.total_cents),
                    user_id,
                    quotation_id,
                    database_id,
                ],
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    /** Soft delete (open or converted). Throws 404 when there is nothing to delete. */
    static async remove(quotation_id, database_id) {
        const [result] = await pool.query(
            `UPDATE quotations SET is_deleted = 1
            WHERE quotation_id = ? AND database_id = ? AND is_deleted = 0`,
            [quotation_id, database_id],
        );
        if (result.affectedRows !== 1) throw notFound();
    }

    /**
     * Called by SellOrdersModel.addOrder, inside the checkout's transaction, when the
     * invoice was converted from a quotation. Marks it converted and links the new
     * sale — only if it is this tenant's open, live quotation; anything else (a
     * malformed id, another tenant's, deleted, already converted) is ignored.
     *
     * Never fails the sale: an error here is logged and the checkout goes on. The
     * exception is an error that may have rolled back the whole transaction (or
     * lost the connection) — continuing would commit half a sale, so it is rethrown.
     *
     * Returns true when the quotation was marked converted.
     */
    static async markConverted(connection, quotation_id, order_id, database_id) {
        if (!isId(quotation_id)) return false;
        try {
            const [result] = await connection.query(
                `UPDATE quotations SET status = 'converted', converted_order_id = ?, converted_at = ?
                WHERE quotation_id = ? AND database_id = ? AND is_deleted = 0 AND status = 'open'`,
                [order_id, now(), Number(quotation_id), database_id],
            );
            return result.affectedRows === 1;
        } catch (error) {
            if (abortsTransaction(error)) throw error;
            console.error("Quotation could not be marked converted:", error);
            return false;
        }
    }
}

module.exports = Quotation;
module.exports.QuotationError = QuotationError;
module.exports.parseQuotation = parseQuotation;
module.exports.parseSearch = parseSearch;
module.exports.isId = isId;
