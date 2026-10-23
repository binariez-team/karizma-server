const crypto = require("crypto");
const pool = require("../config/database");
const Account = require("./AccountsModel");
const moment = require("moment-timezone");
const { toCents, toMoney } = require("./reports-v2/money");

// ---------------------------------------------------------------- cash corrections
//
// The admin's cash corrections (owner decisions C1–C4 and Q4–Q10, 2026-10-22; plan §8
// "Cash corrections with reasons"). Admin only, on his OWN tenant (the token's
// database_id, re-read live; no target shop, C2).
//
// - The reason fixes the direction, the counter account, the voucher number and the
//   voucher's description (the fixed label Cash history shows, reserved in
//   Expense.controller). Two lines, both on the admin's tenant, dated now (Beirut, Q10):
//   into the till   Dr 531|532 / Cr counter;   out of the till   Dr counter / Cr 531|532.
// - The number is the reason's prefix + the voucher's own id (CAP43517), written in the
//   same transaction right after the INSERT: unique by construction, no MAX() scan.
//   journal_notes = the money account ('531'|'532', as EXP and SHR), reference_number =
//   'manual' on the voucher and both lines (the legacy "Manual Transactions" tile keeps
//   counting them), the admin's note on both lines (Cash history shows it).
// - 108 Partner Drawings is never touched: it is SHR-only (M32 reads every 108 line of a
//   user tenant). The admin's own drawings go to 1081 (Q5). The map below holds only
//   101, 1081, 658, 758 and 533, and the writer refuses 108 should it ever appear.
// - Legacy corrections (before reasons, Q6): journal_number 'Manual Transaction', the
//   note as the description, journal_notes 'manual', against 101. Old builds still post
//   them (POST /balance/correct without a reason), limited to Cash / Whish and checked.
// - Edit / delete / reclassify (C4) lock the voucher, then its lines (SELECT … FOR
//   UPDATE, always in that order, several vouchers by ascending id), check the shape
//   (correctionOf), and write with guarded UPDATEs whose affectedRows must match, else
//   everything rolls back. The date never changes. Deletes are soft (voucher + lines).
// - Every write transaction first locks the admin's user_database row (the tenant lock,
//   FOR UPDATE by primary key, before any other read), so the admin's correction writes
//   run one at a time: the single opening safe balance and its date rule (F2) cannot be
//   raced. Lock order everywhere: tenant, then vouchers, then lines.
// - Audit trail (owner answer F1, 2026-10-22; §7.9 cash_correction_audit): every create,
//   edit, delete and bulk change writes one row per voucher it changed (who = the admin's
//   user_id, when = Beirut now, the action, the voucher, and a before / after snapshot:
//   number, date, reason, money account, amount, notes, counter account), in the SAME
//   transaction, after the change: a dry run or any refusal leaves no row, and a missing
//   table refuses the change (409 NOT_SET_UP, §7.9) rather than leave it unrecorded.
// - Opening safe balance (owner answer F2, 2026-10-22): ONE entry per admin tenant,
//   Dr 533 / Cr 101, SOB<journal_id>, dated by the admin (a day, stored at 00:00:00) on
//   or before the first other movement of 533 and never in the future. It never touches
//   the till (531 / 532): not a correction row, not in the cash flow, but in the safe's
//   balance (tillBalance, M36). While it exists, no correction dated before it can become
//   a safe move (BEFORE_SAFE_OPENING), so it always stays the safe's first movement.
// - "Vault" (owner request, 2026-10-23): the screens call 533 the Vault. Only the voucher
//   descriptions written from then on changed ('Moved to Vault', 'Back from Vault',
//   'Opening Vault Balance'); vouchers written before keep 'Moved to Safe', 'Back from
//   Safe' and 'Opening Safe Balance' (an edit or a reclassify rewrites the label), and
//   Expense.controller reserves both sets. Nothing classifies by these descriptions: the
//   number (SFO / SFI / SOB + id) does, so the prefixes, the reason keys (to_safe,
//   from_safe, safe_opening), the routes and the answers' keys are unchanged.
// - GET /balance gives the admin his vault (vault_balance: vaultBalance below, the same
//   Σ as tillBalance's outside_till); every other login gets null.
// - Statements carry /* rk:corrections.* */ markers (logs, tests). Chart ids are read on
//   the transaction's own connection (a second pool connection inside a transaction can
//   deadlock the pool, TransferModel.getMoneyAccountId).

const CORRECTION_REASONS = Object.freeze({
    capital_in: Object.freeze({ prefix: "CAP", account: "101", direction: "in", label: "Capital Added" }),
    owner_drawings: Object.freeze({ prefix: "DRW", account: "1081", direction: "out", label: "Owner Drawings" }),
    unknown_loss: Object.freeze({ prefix: "CLS", account: "658", direction: "out", label: "Unknown Cash Loss" }),
    unknown_gain: Object.freeze({ prefix: "CGN", account: "758", direction: "in", label: "Unknown Cash Gain" }),
    // labels before 2026-10-23: 'Moved to Safe', 'Back from Safe' (still reserved)
    to_safe: Object.freeze({ prefix: "SFO", account: "533", direction: "out", label: "Moved to Vault" }),
    from_safe: Object.freeze({ prefix: "SFI", account: "533", direction: "in", label: "Back from Vault" }),
});
const LEGACY_NUMBER = "Manual Transaction";
const LEGACY_ACCOUNT = "101";
// A legacy correction as the list names it, by the way it moved the till
const LEGACY_REASONS = Object.freeze({ legacy_in: "in", legacy_out: "out" });
const MONEY_ACCOUNTS = ["531", "532"];
const CHART_NUMBERS = ["531", "532", "101", "1081", "658", "758", "533"];
// The opening safe balance (F2): the cash already outside the till when the data starts.
// Not a reason (it never touches the till): its own routes, never in the correction list
// or its signature, so the correction routes answer 404 for it.
const SAFE_OPENING = Object.freeze({
    reason: "safe_opening",
    prefix: "SOB",
    account: "533", // Dr: cash outside the till
    counter: "101", // Cr: capital
    label: "Opening Vault Balance", // 'Opening Safe Balance' before 2026-10-23 (still reserved)
});
// The reasons that move the safe (533): never dated before the opening safe balance
const SAFE_REASONS = Object.keys(CORRECTION_REASONS).filter(
    (key) => CORRECTION_REASONS[key].account === SAFE_OPENING.account,
);
const AUDIT_ACTIONS = ["create", "edit", "delete", "reclassify"];

const reasonOfPrefix = new Map(
    Object.entries(CORRECTION_REASONS).map(([key, r]) => [r.prefix, key]),
);

// A correction voucher: a legacy one, or a number that is exactly a reason's prefix +
// the voucher's own id. Constant text built from the constant prefixes above.
const SIGNATURE_SQL = `(jv.journal_number = '${LEGACY_NUMBER}' OR jv.journal_number IN (${Object.values(
    CORRECTION_REASONS,
)
    .map((r) => `CONCAT('${r.prefix}', jv.journal_id)`)
    .join(", ")}))`;

const CORRECTION_SQL = {
    chart: `/* rk:corrections.chart */ SELECT id, account_number FROM chart_of_accounts WHERE account_number IN (?) ORDER BY id`,
    voucher: `/* rk:corrections.voucher */ INSERT INTO journal_vouchers (database_id, journal_date, journal_number, journal_description, journal_notes, reference_number, total_value) VALUES (?, ?, NULL, ?, ?, 'manual', ?)`,
    number: `/* rk:corrections.number */ UPDATE journal_vouchers SET journal_number = ? WHERE journal_id = ? AND database_id = ? AND journal_number IS NULL`,
    legacyVoucher: `/* rk:corrections.legacy_voucher */ INSERT INTO journal_vouchers (database_id, journal_date, journal_number, journal_description, journal_notes, reference_number, total_value) VALUES (?, ?, '${LEGACY_NUMBER}', ?, 'manual', 'manual', ?)`,
    items: `/* rk:corrections.items */ INSERT INTO journal_items (database_id, journal_id_fk, journal_date, account_id_fk, debit, credit, notes, reference_number) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual'), (?, ?, ?, ?, ?, ?, ?, 'manual')`,
    lock: `/* rk:corrections.lock */ SELECT jv.journal_id, jv.journal_number, jv.journal_date, jv.journal_description, jv.journal_notes, jv.total_value
FROM journal_vouchers jv
WHERE jv.journal_id IN (?) AND jv.database_id = ? AND jv.is_deleted = 0 AND ${SIGNATURE_SQL}
ORDER BY jv.journal_id FOR UPDATE`,
    lockItems: `/* rk:corrections.lock_items */ SELECT journal_item_id, journal_id_fk, account_id_fk, partner_id_fk, debit, credit, database_id, notes
FROM journal_items WHERE journal_id_fk IN (?) AND is_deleted = 0
ORDER BY journal_id_fk, journal_item_id FOR UPDATE`,
    rewriteItem: `/* rk:corrections.rewrite_item */ UPDATE journal_items SET account_id_fk = ?, debit = ?, credit = ?, notes = ?, reference_number = 'manual' WHERE journal_item_id = ? AND journal_id_fk = ? AND database_id = ? AND is_deleted = 0`,
    rewriteVoucher: `/* rk:corrections.rewrite_voucher */ UPDATE journal_vouchers SET journal_number = ?, journal_description = ?, journal_notes = ?, reference_number = 'manual', total_value = ? WHERE journal_id = ? AND database_id = ? AND is_deleted = 0`,
    deleteItems: `/* rk:corrections.delete_items */ UPDATE journal_items SET is_deleted = 1 WHERE journal_id_fk = ? AND database_id = ? AND is_deleted = 0`,
    deleteVoucher: `/* rk:corrections.delete_voucher */ UPDATE journal_vouchers SET is_deleted = 1 WHERE journal_id = ? AND database_id = ? AND is_deleted = 0`,
    // the first statement of every write transaction (primary key: one row)
    tenantLock: `/* rk:corrections.tenant_lock */ SELECT database_id FROM user_database WHERE database_id = ? FOR UPDATE`,
    // §7.9: one row per changed voucher; the VALUES groups are appended (AUDIT_ROW)
    audit: `/* rk:corrections.audit */ INSERT INTO cash_correction_audit (database_id, journal_id, action, user_id, created_at, batch_id, before_json, after_json) VALUES `,
    // the opening safe balance: the admin's live SOB voucher(s), by its exact number. A
    // plain read (never FOR UPDATE: it ranges over the tenant's vouchers); the tenant lock
    // serialises the writers
    safeOpening: `/* rk:corrections.safe_opening */ SELECT jv.journal_id, jv.journal_number, jv.journal_date, jv.total_value
FROM journal_vouchers jv
WHERE jv.database_id = ? AND jv.is_deleted = 0 AND jv.journal_number LIKE '${SAFE_OPENING.prefix}%'
  AND jv.journal_number = CONCAT('${SAFE_OPENING.prefix}', jv.journal_id)
ORDER BY jv.journal_id`,
    openingItems: `/* rk:corrections.safe_opening_items */ SELECT journal_item_id, journal_id_fk, account_id_fk, partner_id_fk, debit, credit, database_id, notes
FROM journal_items WHERE journal_id_fk IN (?) AND is_deleted = 0
ORDER BY journal_id_fk, journal_item_id`,
    lockOpening: `/* rk:corrections.lock_opening */ SELECT jv.journal_id, jv.journal_number, jv.journal_date, jv.journal_description, jv.journal_notes, jv.total_value
FROM journal_vouchers jv
WHERE jv.journal_id = ? AND jv.database_id = ? AND jv.is_deleted = 0
  AND jv.journal_number = CONCAT('${SAFE_OPENING.prefix}', jv.journal_id)
FOR UPDATE`,
    // the first movement of the safe other than the opening itself (M36's line filters)
    firstSafeMove: `/* rk:corrections.first_safe_move */ SELECT MIN(jv.journal_date) AS first_move
FROM journal_items ji JOIN journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
WHERE ji.database_id = ? AND ji.account_id_fk = ? AND ji.is_deleted = 0 AND jv.journal_id <> ?`,
    rewriteOpeningItem: `/* rk:corrections.rewrite_opening_item */ UPDATE journal_items SET debit = ?, credit = ?, notes = ?, journal_date = ?, reference_number = 'manual' WHERE journal_item_id = ? AND journal_id_fk = ? AND database_id = ? AND is_deleted = 0`,
    rewriteOpening: `/* rk:corrections.rewrite_opening */ UPDATE journal_vouchers SET journal_date = ?, total_value = ? WHERE journal_id = ? AND database_id = ? AND is_deleted = 0`,
    balance: `/* rk:corrections.balance */ SELECT
  ROUND(SUM(CASE WHEN account_id_fk = ? THEN debit - credit ELSE 0 END),2) AS cash,
  ROUND(SUM(CASE WHEN account_id_fk = ? THEN debit - credit ELSE 0 END),2) AS whish,
  ROUND(SUM(CASE WHEN account_id_fk = ? THEN debit - credit ELSE 0 END),2) AS outside_till
FROM journal_items WHERE database_id = ? AND is_deleted = 0 AND account_id_fk IN (?, ?, ?)`,
};
const AUDIT_ROW = "(?, ?, ?, ?, ?, ?, ?, ?)";

// The list (C4): one row per voucher, its lines folded, so a voucher of the wrong shape
// still shows once (editable false). Fragments are fixed strings; every value is bound.
const LIST_SELECT = `SELECT jv.journal_id, jv.journal_number, jv.journal_date, jv.journal_description, jv.total_value,
       COUNT(ji.journal_item_id) AS line_count,
       SUM(CASE WHEN ji.account_id_fk IN (?, ?) THEN 1 ELSE 0 END) AS money_lines,
       MAX(CASE WHEN ji.account_id_fk IN (?, ?) THEN ji.account_id_fk END) AS money_id,
       MAX(CASE WHEN ji.account_id_fk NOT IN (?, ?) THEN ji.account_id_fk END) AS counter_id,
       ROUND(SUM(CASE WHEN ji.account_id_fk IN (?, ?) THEN ji.debit - ji.credit ELSE 0 END), 2) AS till_change,
       MAX(CASE WHEN ji.account_id_fk IN (?, ?) THEN ji.notes END) AS line_notes,
       SUM(CASE WHEN ji.database_id = jv.database_id AND ji.partner_id_fk IS NULL THEN 0 ELSE 1 END) AS odd_lines
FROM journal_vouchers jv
LEFT JOIN journal_items ji ON ji.journal_id_fk = jv.journal_id AND ji.is_deleted = 0`;
const LIST_GROUP = `GROUP BY jv.journal_id, jv.journal_number, jv.journal_date, jv.journal_description, jv.total_value`;
const LIST_WHERE = {
    legacy: `jv.journal_number = '${LEGACY_NUMBER}'`,
    reason: "jv.journal_number = CONCAT(?, jv.journal_id)",
    any: SIGNATURE_SQL,
    from: "jv.journal_date >= ?",
    to: "jv.journal_date < ?",
    // the note: a legacy voucher's description, else the lines' notes
    search: `((jv.journal_number = '${LEGACY_NUMBER}' AND jv.journal_description LIKE ?)
     OR (jv.journal_number <> '${LEGACY_NUMBER}' AND EXISTS (SELECT 1 FROM journal_items n
         WHERE n.journal_id_fk = jv.journal_id AND n.is_deleted = 0 AND n.notes LIKE ?)))`,
};
const LIST_HAVING = {
    money: "money_id = ?",
    in: "till_change > 0",
    out: "till_change < 0",
};

/** Chart ids of the correction accounts, by number (null when missing). */
async function correctionChart(runner) {
    const [rows] = await runner.query(CORRECTION_SQL.chart, [CHART_NUMBERS]);
    const byNumber = new Map();
    for (const row of rows) {
        const number = String(row.account_number);
        if (!byNumber.has(number)) byNumber.set(number, Number(row.id));
    }
    const byId = new Map([...byNumber].map(([number, id]) => [id, number]));
    return {
        id: (number) => byNumber.get(number) ?? null,
        number: (id) => (id === null || id === undefined ? null : byId.get(Number(id)) ?? null),
    };
}

/** The counter account of a target class ('legacy' or a reason key). */
const counterOf = (kind) =>
    kind === "legacy" ? LEGACY_ACCOUNT : CORRECTION_REASONS[kind].account;

/** The class of a voucher number: 'legacy', a reason key, or null. */
function kindOf(journalNumber, journalId) {
    const number = String(journalNumber ?? "");
    if (number === LEGACY_NUMBER) return "legacy";
    const key = reasonOfPrefix.get(number.slice(0, 3));
    return key && number === `${CORRECTION_REASONS[key].prefix}${journalId}` ? key : null;
}

/** The list name of a correction: its reason, or legacy_in / legacy_out. */
const listReasonOf = (kind, direction) =>
    kind === "legacy" ? (direction === "in" ? "legacy_in" : "legacy_out") : kind;

/** The audit snapshot of a locked correction (correctionOf), before a change. */
const snapshotOf = (c) => ({
    journal_number: c.journal_number,
    date: c.journal_date,
    reason: listReasonOf(c.kind, c.direction),
    money_account: c.money_account,
    amount: toMoney(c.amount_c),
    notes: c.notes,
    account: counterOf(c.kind),
});

/** The audit snapshot of correction `c` once rewritten as `target` (rewriteCorrection). */
const targetSnapshotOf = (c, target, journal_number) => ({
    journal_number,
    date: c.journal_date,
    reason: listReasonOf(target.kind, target.direction),
    money_account: target.money_account,
    amount: target.amount,
    notes: target.notes,
    account: counterOf(target.kind),
});

/** The audit snapshot of an opening safe balance. */
const openingSnapshotOf = ({ journal_number, journal_date, amount, notes }) => ({
    journal_number,
    date: journal_date,
    reason: SAFE_OPENING.reason,
    money_account: SAFE_OPENING.account,
    amount,
    notes,
    account: SAFE_OPENING.counter,
});

const SNAPSHOT_KEYS = ["journal_number", "date", "reason", "money_account", "amount", "notes", "account"];

/** A stored snapshot (mysql2 parses a JSON column; a string is parsed here), fixed keys. */
function readSnapshot(value) {
    if (value === null || value === undefined) return null;
    let parsed = value;
    if (typeof value === "string") {
        try {
            parsed = JSON.parse(value);
        } catch (error) {
            return null;
        }
    }
    if (!parsed || typeof parsed !== "object") return null;
    return Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, parsed[key] ?? null]));
}

/**
 * The opening safe balance a locked voucher holds, or null when it is not one the routes
 * may rewrite: exactly two live lines on the admin's tenant, no customer or supplier,
 * one on 533 debited and one on 101 credited, both equal to the voucher's total.
 */
function openingOf(voucher, lines, chart, databaseId) {
    const journalId = Number(voucher.journal_id);
    if (String(voucher.journal_number) !== `${SAFE_OPENING.prefix}${journalId}`) return null;
    if (lines.length !== 2) return null;
    const foreign = (l) =>
        Number(l.database_id) !== databaseId ||
        (l.partner_id_fk !== null && l.partner_id_fk !== undefined);
    if (lines.some(foreign)) return null;
    const safe = lines.filter((l) => chart.number(l.account_id_fk) === SAFE_OPENING.account);
    const capital = lines.filter((l) => chart.number(l.account_id_fk) === SAFE_OPENING.counter);
    if (safe.length !== 1 || capital.length !== 1) return null;
    const amountC = toCents(voucher.total_value);
    if (
        amountC < 1 ||
        toCents(safe[0].debit) !== amountC ||
        toCents(safe[0].credit) !== 0 ||
        toCents(capital[0].credit) !== amountC ||
        toCents(capital[0].debit) !== 0
    ) {
        return null;
    }
    return {
        journal_id: journalId,
        journal_number: String(voucher.journal_number),
        journal_date: String(voucher.journal_date),
        amount_c: amountC,
        notes: safe[0].notes ?? null,
        safeLine: safe[0],
        capitalLine: capital[0],
    };
}

/** The day ('YYYY-MM-DD') of the safe's first movement other than `exceptId`, or null. */
async function firstSafeMove(runner, safeId, databaseId, exceptId) {
    const [[row]] = await runner.query(CORRECTION_SQL.firstSafeMove, [databaseId, safeId, exceptId]);
    const first = row?.first_move ?? null;
    return first === null ? null : String(first).slice(0, 10);
}

/**
 * The correction a locked voucher holds, or null when the corrections routes may not
 * rewrite it: exactly two live lines on the admin's tenant, no customer or supplier on
 * them, one on Cash or Whish and the other on its class's counter account, one-sided,
 * mirrored and equal to the voucher's total; a reason voucher moves the till its
 * reason's way.
 */
function correctionOf(voucher, lines, chart, databaseId) {
    const journalId = Number(voucher.journal_id);
    const kind = kindOf(voucher.journal_number, journalId);
    if (!kind || lines.length !== 2) return null;
    const foreign = (l) =>
        Number(l.database_id) !== databaseId ||
        (l.partner_id_fk !== null && l.partner_id_fk !== undefined);
    if (lines.some(foreign)) return null;
    const isMoney = (l) => MONEY_ACCOUNTS.includes(chart.number(l.account_id_fk));
    const money = lines.filter(isMoney);
    const counter = lines.filter((l) => !isMoney(l));
    if (money.length !== 1 || counter.length !== 1) return null;
    if (chart.number(counter[0].account_id_fk) !== counterOf(kind)) return null;

    const debit = toCents(money[0].debit);
    const credit = toCents(money[0].credit);
    if ((debit > 0) === (credit > 0) || debit < 0 || credit < 0) return null;
    if (toCents(counter[0].debit) !== credit || toCents(counter[0].credit) !== debit) return null;
    const amountC = debit + credit;
    if (amountC !== toCents(voucher.total_value)) return null;
    const direction = debit > 0 ? "in" : "out";
    if (kind !== "legacy" && CORRECTION_REASONS[kind].direction !== direction) return null;

    return {
        journal_id: journalId,
        journal_number: String(voucher.journal_number),
        journal_date: String(voucher.journal_date),
        description: voucher.journal_description ?? null,
        kind,
        direction,
        money_account: chart.number(money[0].account_id_fk),
        amount_c: amountC,
        notes: kind === "legacy" ? voucher.journal_description ?? null : money[0].notes ?? null,
        moneyLine: money[0],
        counterLine: counter[0],
    };
}

class BalanceModel {
    // get balance
    static async getBalance(database_id) {
        const [_531] = await Account.getIdByAccountNumber("531");
        const [_532] = await Account.getIdByAccountNumber("532");

        const query = `SELECT
                COALESCE(SUM(CASE 
                WHEN ji.account_id_fk = ? AND ji.database_id = ? 
                THEN ji.debit - ji.credit 
                ELSE 0 
                END), 0) AS cash_balance,
            
                COALESCE(SUM(CASE 
                WHEN ji.account_id_fk = ? AND ji.database_id = ? 
                THEN ji.debit - ji.credit 
                ELSE 0 
                END), 0) AS whish_balance
            
            FROM journal_items ji
            WHERE ji.is_deleted = 0;`;

        const [[rows]] = await pool.query(query, [
            _531.id,
            database_id,
            _532.id,
            database_id,
        ]);

        return rows;
    }

    // ------------------------------------------------------------ cash corrections

    // Outcomes; every one but OK is returned after a rollback, with nothing written
    static OK = "ok";
    static NOT_FOUND = "not_found";
    static NOT_SET_UP = "not_set_up";
    static NOT_EDITABLE = "not_editable";
    static DIRECTION_MISMATCH = "direction_mismatch";
    static STAYS_LEGACY_ONLY = "stays_legacy_only";
    // §7.9 not run: no cash_correction_audit table, so nothing may change unrecorded (F1)
    static AUDIT_NOT_SET_UP = "audit_not_set_up";
    // F2: a second opening safe balance; its date after the safe's first movement; a safe
    // move dated before the opening
    static SAFE_OPENING_EXISTS = "safe_opening_exists";
    static OPENING_AFTER_FIRST_MOVE = "opening_after_first_move";
    static BEFORE_SAFE_OPENING = "before_safe_opening";

    static CORRECTION_REASONS = CORRECTION_REASONS;
    static LEGACY_REASONS = LEGACY_REASONS;
    static MONEY_ACCOUNTS = MONEY_ACCOUNTS;
    static SAFE_OPENING = SAFE_OPENING;
    static AUDIT_ACTIONS = AUDIT_ACTIONS;

    /** The voucher number of a reason's correction: CAP43517. */
    static correctionNumber(reason, journal_id) {
        return `${CORRECTION_REASONS[reason].prefix}${journal_id}`;
    }

    /**
     * Run `work(connection)` in one transaction on the admin's tenant: the tenant lock
     * first (before any other read, so every read sees the writes committed before it),
     * then the work. Committed only when it returns OK and `commit` is true (a dry run
     * rolls back what it wrote, its audit rows included), else rolled back.
     */
    static async inCorrectionTransaction(database_id, work, { commit = true } = {}) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(CORRECTION_SQL.tenantLock, [database_id]);
            const result = await work(connection);
            if (result.status === BalanceModel.OK && commit) await connection.commit();
            else await connection.rollback();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    /**
     * The admin's till (531, 532) and safe (533), as 2-decimal strings, and the warning
     * flags: Q7 for the till, and the same for cash outside the till (a from_safe beyond
     * what the safe holds, or a bulk change; warned about, never refused).
     */
    static async tillBalance(runner, chart, database_id) {
        const ids = ["531", "532", "533"].map((n) => chart.id(n) ?? 0); // 0 matches no account
        const [[row]] = await runner.query(CORRECTION_SQL.balance, [
            ids[0], ids[1], ids[2], database_id, ids[0], ids[1], ids[2],
        ]);
        const cash = toCents(row?.cash ?? null);
        const whish = toCents(row?.whish ?? null);
        const outside = toCents(row?.outside_till ?? null);
        return {
            balance: {
                cash: toMoney(cash),
                whish: toMoney(whish),
                outside_till: toMoney(outside),
            },
            // Q7: a till below zero is warned about, never refused
            negative_till: cash < 0 || whish < 0,
            negative_outside_till: outside < 0,
        };
    }

    /**
     * The admin's vault for GET /balance (owner request, 2026-10-23): the balance of 533
     * on `database_id`, as a 2-decimal string (signed), or null while the chart has no
     * 533 (§7.8 not run). tillBalance's outside_till itself, so it is the figure of the
     * corrections list and of the correction answers (and M36's rule: Σ(debit − credit)
     * of the tenant's live 533 lines). The caller passes the admin's own tenant only.
     */
    static async vaultBalance(database_id) {
        const chart = await correctionChart(pool);
        if (chart.id(SAFE_OPENING.account) === null) return null;
        const { balance } = await BalanceModel.tillBalance(pool, chart, database_id);
        return balance.outside_till;
    }

    /**
     * The audit rows of one change (F1, §7.9), inside its transaction: `rows` are
     * { journal_id, action, before, after } (snapshots or null), `actor` { user_id, at }.
     * False when the table is missing (§7.9 not run): the caller refuses the change.
     */
    static async writeAudit(connection, database_id, actor, rows, batch_id = null) {
        if (!rows.length) return true;
        const userId = Number(actor?.user_id);
        if (!Number.isSafeInteger(userId) || userId < 1 || typeof actor.at !== "string") {
            throw new Error("A correction change needs its user and time (audit)");
        }
        const params = [];
        for (const row of rows) {
            if (!AUDIT_ACTIONS.includes(row.action)) throw new Error(`Unknown audit action ${row.action}`);
            params.push(
                database_id,
                row.journal_id,
                row.action,
                userId,
                actor.at,
                batch_id,
                row.before ? JSON.stringify(row.before) : null,
                row.after ? JSON.stringify(row.after) : null,
            );
        }
        try {
            await connection.query(
                CORRECTION_SQL.audit + rows.map(() => AUDIT_ROW).join(", "),
                params,
            );
        } catch (error) {
            if (error && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146)) return false;
            throw error;
        }
        return true;
    }

    /**
     * F2: while an opening safe balance exists, a correction dated before it may not
     * become a safe move (to_safe / from_safe), so the opening stays the safe's first
     * movement. `corrections` are the locked ones about to take reason `kind`.
     */
    static async beforeSafeOpening(runner, database_id, kind, corrections) {
        if (!SAFE_REASONS.includes(kind) || !corrections.length) return null;
        const [openings] = await runner.query(CORRECTION_SQL.safeOpening, [database_id]);
        if (!openings.length) return null;
        const openedAt = openings.map((o) => String(o.journal_date)).sort()[0];
        const early = corrections.filter((c) => c.journal_date < openedAt);
        if (!early.length) return null;
        return {
            status: BalanceModel.BEFORE_SAFE_OPENING,
            ids: early.map((c) => c.journal_id),
            opening_date: openedAt.slice(0, 10),
            earliest: early.map((c) => c.journal_date).sort()[0].slice(0, 10),
        };
    }

    /**
     * The opening safe balance block of the list and of the opening answers (F2):
     * { available (533 and 101 in the chart), entry (null, or { journal_id,
     * journal_number, date 'YYYY-MM-DD', amount, notes, editable }), earliest_movement
     * (the day of the safe's first other movement, or null), max_date (the latest day the
     * opening may take: earliest_movement, else today) }.
     */
    static async safeOpeningState(runner, chart, database_id, today) {
        const safeId = chart.id(SAFE_OPENING.account);
        if (safeId === null || chart.id(SAFE_OPENING.counter) === null) {
            return { available: false, entry: null, earliest_movement: null, max_date: today };
        }
        const [openings] = await runner.query(CORRECTION_SQL.safeOpening, [database_id]);
        let entry = null;
        let exceptId = 0;
        if (openings.length) {
            const v = openings[0];
            exceptId = Number(v.journal_id);
            const [lines] = await runner.query(CORRECTION_SQL.openingItems, [[exceptId]]);
            const o = openingOf(v, lines, chart, database_id);
            entry = {
                journal_id: exceptId,
                journal_number: String(v.journal_number),
                date: String(v.journal_date).slice(0, 10),
                amount: toMoney(o ? o.amount_c : toCents(v.total_value)),
                notes: o ? o.notes : null,
                editable: o !== null,
            };
        }
        const earliest = await firstSafeMove(runner, safeId, database_id, exceptId);
        return {
            available: true,
            entry,
            earliest_movement: earliest,
            max_date: earliest !== null && earliest < today ? earliest : today,
        };
    }

    /** Lock the vouchers (ascending id), then their lines; fold them by voucher. */
    static async lockCorrections(connection, ids, database_id) {
        const [vouchers] = await connection.query(CORRECTION_SQL.lock, [ids, database_id]);
        if (!vouchers.length) return { vouchers, linesOf: () => [] };
        const [lines] = await connection.query(CORRECTION_SQL.lockItems, [
            vouchers.map((v) => Number(v.journal_id)),
        ]);
        const byVoucher = new Map();
        for (const line of lines) {
            const key = Number(line.journal_id_fk);
            if (!byVoucher.has(key)) byVoucher.set(key, []);
            byVoucher.get(key).push(line);
        }
        return { vouchers, linesOf: (journal_id) => byVoucher.get(Number(journal_id)) || [] };
    }

    /**
     * Rewrite a locked correction `c` (correctionOf) as `target`: { kind: 'legacy' | a
     * reason, direction, money_account, amount (a 2-decimal string), notes }. Its two
     * lines keep their ids and the voucher keeps its id and date; the number, the
     * description, journal_notes and the total follow the target. A legacy target keeps
     * the lines' own notes (the note is the description). Returns an outcome.
     */
    static async rewriteCorrection(connection, chart, database_id, c, target) {
        const counterNumber = counterOf(target.kind);
        // 108 is SHR-only (M32): never a correction's account, whatever the map says
        if (counterNumber === "108" || target.money_account === "108") {
            throw new Error("A cash correction never posts to 108");
        }
        const moneyId = chart.id(target.money_account);
        const counterId = chart.id(counterNumber);
        if (moneyId === null) throw new Error(`Chart account ${target.money_account} not found`);
        if (counterId === null) return { status: BalanceModel.NOT_SET_UP };

        const amount = target.amount;
        const into = target.direction === "in";
        const legacy = target.kind === "legacy";
        const lines = [
            [moneyId, into ? amount : 0, into ? 0 : amount, c.moneyLine],
            [counterId, into ? 0 : amount, into ? amount : 0, c.counterLine],
        ];
        for (const [accountId, debit, credit, line] of lines) {
            const [update] = await connection.query(CORRECTION_SQL.rewriteItem, [
                accountId,
                debit,
                credit,
                legacy ? line.notes ?? null : target.notes,
                Number(line.journal_item_id),
                c.journal_id,
                database_id,
            ]);
            if (update.affectedRows !== 1) return { status: BalanceModel.NOT_FOUND };
        }
        const number = legacy
            ? LEGACY_NUMBER
            : BalanceModel.correctionNumber(target.kind, c.journal_id);
        const [voucher] = await connection.query(CORRECTION_SQL.rewriteVoucher, [
            number,
            legacy ? target.notes : CORRECTION_REASONS[target.kind].label,
            legacy ? "manual" : target.money_account,
            amount,
            c.journal_id,
            database_id,
        ]);
        if (voucher.affectedRows !== 1) return { status: BalanceModel.NOT_FOUND };
        return { status: BalanceModel.OK, journal_number: number };
    }

    /**
     * A new correction on the admin's own tenant, dated `date` (Beirut now, Q10).
     * `entry`: { reason: a reason key, or null for a legacy one (old builds, Q6),
     * direction ('in' | 'out'; the reason's own, or ADD / REMOVE on the legacy path),
     * money_account ('531' | '532'), amount (a 2-decimal string), notes (a string) }.
     */
    static async createCorrection(database_id, entry, date, actor) {
        return BalanceModel.inCorrectionTransaction(database_id, async (connection) => {
            const chart = await correctionChart(connection);
            const kind = entry.reason ?? "legacy";
            const counterNumber = counterOf(kind);
            if (counterNumber === "108" || entry.money_account === "108") {
                throw new Error("A cash correction never posts to 108");
            }
            const moneyId = chart.id(entry.money_account);
            const counterId = chart.id(counterNumber);
            if (moneyId === null) throw new Error(`Chart account ${entry.money_account} not found`);
            if (counterId === null) return { status: BalanceModel.NOT_SET_UP };

            const legacy = kind === "legacy";
            const [voucher] = legacy
                ? await connection.query(CORRECTION_SQL.legacyVoucher, [
                      database_id,
                      date,
                      entry.notes,
                      entry.amount,
                  ])
                : await connection.query(CORRECTION_SQL.voucher, [
                      database_id,
                      date,
                      CORRECTION_REASONS[kind].label,
                      entry.money_account,
                      entry.amount,
                  ]);
            const journal_id = Number(voucher.insertId);
            let journal_number = LEGACY_NUMBER;
            if (!legacy) {
                journal_number = BalanceModel.correctionNumber(kind, journal_id);
                const [numbered] = await connection.query(CORRECTION_SQL.number, [
                    journal_number,
                    journal_id,
                    database_id,
                ]);
                if (numbered.affectedRows !== 1) throw new Error("Correction number not written");
            }

            // a reason fixes the way the till moves; ADD / REMOVE only on the legacy path
            const direction = legacy ? entry.direction : CORRECTION_REASONS[kind].direction;
            const into = direction === "in";
            const amount = entry.amount;
            // legacy lines carry no note (as before: the note is the description)
            const notes = legacy ? null : entry.notes;
            await connection.query(CORRECTION_SQL.items, [
                database_id, journal_id, date, moneyId, into ? amount : 0, into ? 0 : amount, notes,
                database_id, journal_id, date, counterId, into ? 0 : amount, into ? amount : 0, notes,
            ]);

            const audited = await BalanceModel.writeAudit(connection, database_id, actor, [
                {
                    journal_id,
                    action: "create",
                    before: null,
                    after: {
                        journal_number,
                        date,
                        reason: listReasonOf(kind, direction),
                        money_account: entry.money_account,
                        amount,
                        notes: entry.notes,
                        account: counterNumber,
                    },
                },
            ]);
            if (!audited) return { status: BalanceModel.AUDIT_NOT_SET_UP };

            return {
                status: BalanceModel.OK,
                journal_id,
                journal_number,
                reason: listReasonOf(kind, direction),
                ...(await BalanceModel.tillBalance(connection, chart, database_id)),
            };
        });
    }

    /**
     * Edit a correction (C4): reason, money account, amount and note; the date never
     * changes. `edit.reason` is a reason key, or legacy_in / legacy_out to keep an old
     * correction as one (only an old correction can stay one).
     */
    static async updateCorrection(database_id, journal_id, edit, actor) {
        return BalanceModel.inCorrectionTransaction(database_id, async (connection) => {
            const { vouchers, linesOf } = await BalanceModel.lockCorrections(
                connection,
                [journal_id],
                database_id,
            );
            if (!vouchers.length) return { status: BalanceModel.NOT_FOUND };
            const chart = await correctionChart(connection);
            const c = correctionOf(vouchers[0], linesOf(journal_id), chart, database_id);
            if (!c) return { status: BalanceModel.NOT_EDITABLE, ids: [journal_id] };

            const legacyTarget = Object.prototype.hasOwnProperty.call(LEGACY_REASONS, edit.reason);
            if (legacyTarget && c.kind !== "legacy") {
                return { status: BalanceModel.STAYS_LEGACY_ONLY };
            }
            const kind = legacyTarget ? "legacy" : edit.reason;
            const target = {
                kind,
                direction: legacyTarget ? LEGACY_REASONS[edit.reason] : CORRECTION_REASONS[kind].direction,
                money_account: edit.money_account,
                amount: edit.amount,
                notes: edit.notes,
            };
            const early = await BalanceModel.beforeSafeOpening(connection, database_id, kind, [c]);
            if (early) return early;
            const written = await BalanceModel.rewriteCorrection(connection, chart, database_id, c, target);
            if (written.status !== BalanceModel.OK) return written;
            const audited = await BalanceModel.writeAudit(connection, database_id, actor, [
                {
                    journal_id,
                    action: "edit",
                    before: snapshotOf(c),
                    after: targetSnapshotOf(c, target, written.journal_number),
                },
            ]);
            if (!audited) return { status: BalanceModel.AUDIT_NOT_SET_UP };
            return {
                status: BalanceModel.OK,
                journal_id,
                journal_number: written.journal_number,
                reason: listReasonOf(kind, target.direction),
                ...(await BalanceModel.tillBalance(connection, chart, database_id)),
            };
        });
    }

    /** Soft-delete a correction: the voucher and both lines (C4). */
    static async deleteCorrection(database_id, journal_id, actor) {
        return BalanceModel.inCorrectionTransaction(database_id, async (connection) => {
            const { vouchers, linesOf } = await BalanceModel.lockCorrections(
                connection,
                [journal_id],
                database_id,
            );
            if (!vouchers.length) return { status: BalanceModel.NOT_FOUND };
            const chart = await correctionChart(connection);
            const c = correctionOf(vouchers[0], linesOf(journal_id), chart, database_id);
            if (!c) return { status: BalanceModel.NOT_EDITABLE, ids: [journal_id] };

            const [items] = await connection.query(CORRECTION_SQL.deleteItems, [journal_id, database_id]);
            if (items.affectedRows !== 2) return { status: BalanceModel.NOT_FOUND };
            const [voucher] = await connection.query(CORRECTION_SQL.deleteVoucher, [journal_id, database_id]);
            if (voucher.affectedRows !== 1) return { status: BalanceModel.NOT_FOUND };
            const audited = await BalanceModel.writeAudit(connection, database_id, actor, [
                { journal_id, action: "delete", before: snapshotOf(c), after: null },
            ]);
            if (!audited) return { status: BalanceModel.AUDIT_NOT_SET_UP };
            return {
                status: BalanceModel.OK,
                journal_id,
                journal_number: c.journal_number,
                ...(await BalanceModel.tillBalance(connection, chart, database_id)),
            };
        });
    }

    /**
     * Give several corrections one reason (C4, bulk): e.g. the old "to hasan" entries →
     * to_safe. The amount, the money account, the date and the way the till moved never
     * change, so every selected correction must move the till the reason's way
     * (DIRECTION_MISMATCH lists those that do not). An old correction's note (its
     * description) moves to the lines. Corrections already on that reason are left as
     * they are. `dryRun`: everything is checked and written, then rolled back (the
     * confirm dialog's count and totals).
     */
    static async reclassifyCorrections(database_id, ids, reason, { dryRun = false } = {}, actor) {
        const r = CORRECTION_REASONS[reason];
        return BalanceModel.inCorrectionTransaction(
            database_id,
            async (connection) => {
                const { vouchers, linesOf } = await BalanceModel.lockCorrections(
                    connection,
                    ids,
                    database_id,
                );
                if (vouchers.length !== ids.length) {
                    const found = new Set(vouchers.map((v) => Number(v.journal_id)));
                    return { status: BalanceModel.NOT_FOUND, ids: ids.filter((id) => !found.has(id)) };
                }
                const chart = await correctionChart(connection);
                if (chart.id(r.account) === null) return { status: BalanceModel.NOT_SET_UP };

                const list = vouchers.map((v) => ({
                    v,
                    c: correctionOf(v, linesOf(v.journal_id), chart, database_id),
                }));
                const bad = list.filter((x) => !x.c).map((x) => Number(x.v.journal_id));
                if (bad.length) return { status: BalanceModel.NOT_EDITABLE, ids: bad };
                const wrongWay = list.filter((x) => x.c.direction !== r.direction);
                if (wrongWay.length) {
                    return {
                        status: BalanceModel.DIRECTION_MISMATCH,
                        ids: wrongWay.map((x) => x.c.journal_id),
                        direction: r.direction,
                    };
                }

                const early = await BalanceModel.beforeSafeOpening(
                    connection,
                    database_id,
                    reason,
                    list.filter((x) => x.c.kind !== reason).map((x) => x.c),
                );
                if (early) return early;

                let updated = 0;
                let intoC = 0;
                let outC = 0;
                const audits = [];
                for (const { c } of list) {
                    if (c.direction === "in") intoC += c.amount_c;
                    else outC += c.amount_c;
                    if (c.kind === reason) continue;
                    const notes =
                        c.kind === "legacy"
                            ? String(c.description ?? "").trim() || null
                            : c.moneyLine.notes ?? null;
                    const target = {
                        kind: reason,
                        direction: c.direction,
                        money_account: c.money_account,
                        amount: toMoney(c.amount_c),
                        notes,
                    };
                    const written = await BalanceModel.rewriteCorrection(connection, chart, database_id, c, target);
                    if (written.status !== BalanceModel.OK) return written;
                    audits.push({
                        journal_id: c.journal_id,
                        action: "reclassify",
                        before: snapshotOf(c),
                        after: targetSnapshotOf(c, target, written.journal_number),
                    });
                    updated++;
                }
                // one batch id per bulk change, so the trail shows it as one action
                const audited = await BalanceModel.writeAudit(
                    connection,
                    database_id,
                    actor,
                    audits,
                    audits.length ? crypto.randomUUID() : null,
                );
                if (!audited) return { status: BalanceModel.AUDIT_NOT_SET_UP };
                return {
                    status: BalanceModel.OK,
                    count: list.length,
                    updated,
                    unchanged: list.length - updated,
                    total: toMoney(intoC + outC),
                    into_till: toMoney(intoC),
                    out_of_till: toMoney(outC),
                    ...(await BalanceModel.tillBalance(connection, chart, database_id)),
                };
            },
            { commit: !dryRun },
        );
    }

    // ---------------------------------------------------- opening safe balance (F2)

    /**
     * The admin's one opening safe balance (F2): Dr 533 / Cr 101, SOB<journal_id>, dated
     * `entry.day` at 00:00:00. `entry`: { amount (a 2-decimal string), day ('YYYY-MM-DD',
     * not after today: checked by the caller), notes (a string or null) }. Refused while
     * one exists (SAFE_OPENING_EXISTS) and when the day is after the safe's first
     * movement (OPENING_AFTER_FIRST_MOVE). `actor` { user_id, at }: who and when (audit;
     * at's day is the answer's today).
     */
    static async createSafeOpening(database_id, entry, actor) {
        return BalanceModel.inCorrectionTransaction(database_id, async (connection) => {
            const chart = await correctionChart(connection);
            const safeId = chart.id(SAFE_OPENING.account);
            const capitalId = chart.id(SAFE_OPENING.counter);
            if (safeId === null || capitalId === null) return { status: BalanceModel.NOT_SET_UP };

            const [openings] = await connection.query(CORRECTION_SQL.safeOpening, [database_id]);
            if (openings.length) {
                return {
                    status: BalanceModel.SAFE_OPENING_EXISTS,
                    journal_id: Number(openings[0].journal_id),
                    journal_number: String(openings[0].journal_number),
                };
            }
            const first = await firstSafeMove(connection, safeId, database_id, 0);
            if (first !== null && entry.day > first) {
                return { status: BalanceModel.OPENING_AFTER_FIRST_MOVE, max_date: first };
            }

            const date = `${entry.day} 00:00:00`;
            const [voucher] = await connection.query(CORRECTION_SQL.voucher, [
                database_id,
                date,
                SAFE_OPENING.label,
                SAFE_OPENING.account,
                entry.amount,
            ]);
            const journal_id = Number(voucher.insertId);
            const journal_number = `${SAFE_OPENING.prefix}${journal_id}`;
            const [numbered] = await connection.query(CORRECTION_SQL.number, [
                journal_number,
                journal_id,
                database_id,
            ]);
            if (numbered.affectedRows !== 1) throw new Error("Opening number not written");
            // the safe in, capital credited: the till (531 / 532) is never touched
            await connection.query(CORRECTION_SQL.items, [
                database_id, journal_id, date, safeId, entry.amount, 0, entry.notes,
                database_id, journal_id, date, capitalId, 0, entry.amount, entry.notes,
            ]);

            const audited = await BalanceModel.writeAudit(connection, database_id, actor, [
                {
                    journal_id,
                    action: "create",
                    before: null,
                    after: openingSnapshotOf({ journal_number, journal_date: date, amount: entry.amount, notes: entry.notes }),
                },
            ]);
            if (!audited) return { status: BalanceModel.AUDIT_NOT_SET_UP };
            return {
                status: BalanceModel.OK,
                journal_id,
                journal_number,
                safe_opening: await BalanceModel.safeOpeningState(connection, chart, database_id, actor.at.slice(0, 10)),
                ...(await BalanceModel.tillBalance(connection, chart, database_id)),
            };
        });
    }

    /** Lock the opening voucher, then its lines, and check its shape (openingOf). */
    static async lockOpening(connection, journal_id, database_id) {
        const [vouchers] = await connection.query(CORRECTION_SQL.lockOpening, [journal_id, database_id]);
        if (!vouchers.length) return { status: BalanceModel.NOT_FOUND };
        const [lines] = await connection.query(CORRECTION_SQL.lockItems, [[journal_id]]);
        const chart = await correctionChart(connection);
        const o = openingOf(vouchers[0], lines, chart, database_id);
        if (!o) return { status: BalanceModel.NOT_EDITABLE, ids: [journal_id] };
        return { status: BalanceModel.OK, chart, o };
    }

    /**
     * Edit the opening safe balance (F2): amount, day and note; the number stays. The day
     * follows the create rule, its own lines left out of the first movement.
     */
    static async updateSafeOpening(database_id, journal_id, entry, actor) {
        return BalanceModel.inCorrectionTransaction(database_id, async (connection) => {
            const locked = await BalanceModel.lockOpening(connection, journal_id, database_id);
            if (locked.status !== BalanceModel.OK) return locked;
            const { chart, o } = locked;
            const first = await firstSafeMove(connection, chart.id(SAFE_OPENING.account), database_id, journal_id);
            if (first !== null && entry.day > first) {
                return { status: BalanceModel.OPENING_AFTER_FIRST_MOVE, max_date: first };
            }

            const date = `${entry.day} 00:00:00`;
            for (const [debit, credit, line] of [
                [entry.amount, 0, o.safeLine],
                [0, entry.amount, o.capitalLine],
            ]) {
                const [update] = await connection.query(CORRECTION_SQL.rewriteOpeningItem, [
                    debit,
                    credit,
                    entry.notes,
                    date,
                    Number(line.journal_item_id),
                    journal_id,
                    database_id,
                ]);
                if (update.affectedRows !== 1) return { status: BalanceModel.NOT_FOUND };
            }
            const [voucher] = await connection.query(CORRECTION_SQL.rewriteOpening, [
                date,
                entry.amount,
                journal_id,
                database_id,
            ]);
            if (voucher.affectedRows !== 1) return { status: BalanceModel.NOT_FOUND };

            const audited = await BalanceModel.writeAudit(connection, database_id, actor, [
                {
                    journal_id,
                    action: "edit",
                    before: openingSnapshotOf({ ...o, amount: toMoney(o.amount_c) }),
                    after: openingSnapshotOf({ journal_number: o.journal_number, journal_date: date, amount: entry.amount, notes: entry.notes }),
                },
            ]);
            if (!audited) return { status: BalanceModel.AUDIT_NOT_SET_UP };
            return {
                status: BalanceModel.OK,
                journal_id,
                journal_number: o.journal_number,
                safe_opening: await BalanceModel.safeOpeningState(connection, chart, database_id, actor.at.slice(0, 10)),
                ...(await BalanceModel.tillBalance(connection, chart, database_id)),
            };
        });
    }

    /** Soft-delete the opening safe balance: the voucher and both lines (F2). */
    static async deleteSafeOpening(database_id, journal_id, actor) {
        return BalanceModel.inCorrectionTransaction(database_id, async (connection) => {
            const locked = await BalanceModel.lockOpening(connection, journal_id, database_id);
            if (locked.status !== BalanceModel.OK) return locked;
            const { chart, o } = locked;
            const [items] = await connection.query(CORRECTION_SQL.deleteItems, [journal_id, database_id]);
            if (items.affectedRows !== 2) return { status: BalanceModel.NOT_FOUND };
            const [voucher] = await connection.query(CORRECTION_SQL.deleteVoucher, [journal_id, database_id]);
            if (voucher.affectedRows !== 1) return { status: BalanceModel.NOT_FOUND };
            const audited = await BalanceModel.writeAudit(connection, database_id, actor, [
                { journal_id, action: "delete", before: openingSnapshotOf({ ...o, amount: toMoney(o.amount_c) }), after: null },
            ]);
            if (!audited) return { status: BalanceModel.AUDIT_NOT_SET_UP };
            return {
                status: BalanceModel.OK,
                journal_id,
                journal_number: o.journal_number,
                safe_opening: await BalanceModel.safeOpeningState(connection, chart, database_id, actor.at.slice(0, 10)),
                ...(await BalanceModel.tillBalance(connection, chart, database_id)),
            };
        });
    }

    // ------------------------------------------------------------ audit trail (F1)

    /**
     * The admin's correction history, newest first (F1, §7.9): `q` { journal_id (or
     * null), action (or null), lo, hi (wall-clock bounds of created_at, or null), limit,
     * offset }. `set_up: false` with no rows while the table is missing.
     */
    static async listAudit(database_id, q) {
        const where = ["a.database_id = ?"];
        const params = [database_id];
        if (q.journal_id) {
            where.push("a.journal_id = ?");
            params.push(q.journal_id);
        }
        if (q.action) {
            where.push("a.action = ?");
            params.push(q.action);
        }
        if (q.lo) {
            where.push("a.created_at >= ?");
            params.push(q.lo);
        }
        if (q.hi) {
            where.push("a.created_at < ?");
            params.push(q.hi);
        }
        let count;
        try {
            [[count]] = await pool.query(
                `/* rk:corrections.audit_count */ SELECT COUNT(*) AS n FROM cash_correction_audit a
WHERE ${where.join(" AND ")}`,
                params,
            );
        } catch (error) {
            if (error && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146)) {
                return { set_up: false, total: 0, rows: [] };
            }
            throw error;
        }
        const [rows] = await pool.query(
            `/* rk:corrections.audit_list */ SELECT a.audit_id, a.journal_id, a.action, a.user_id, a.created_at, a.batch_id,
       a.before_json, a.after_json, u.first_name, u.last_name, u.username
FROM cash_correction_audit a
LEFT JOIN users u ON u.user_id = a.user_id
WHERE ${where.join(" AND ")}
ORDER BY a.created_at DESC, a.audit_id DESC
LIMIT ? OFFSET ?`,
            [...params, q.limit, q.offset],
        );
        return {
            set_up: true,
            total: Number(count?.n ?? 0),
            rows: rows.map((row) => {
                const name = [row.first_name, row.last_name]
                    .filter((part) => part !== null && part !== undefined && String(part).trim())
                    .join(" ");
                const before = readSnapshot(row.before_json);
                const after = readSnapshot(row.after_json);
                return {
                    audit_id: Number(row.audit_id),
                    at: String(row.created_at),
                    action: String(row.action),
                    journal_id: Number(row.journal_id),
                    // the voucher's number after the change (before it, on a delete)
                    journal_number: after?.journal_number ?? before?.journal_number ?? null,
                    user_id: Number(row.user_id),
                    user_name: name || (row.username ?? null),
                    batch_id: row.batch_id ?? null,
                    before,
                    after,
                };
            }),
        };
    }

    /**
     * The admin's corrections, newest first (C4): new ones and old ones ("Old
     * correction", legacy_in / legacy_out). `q`: { lo, hi (wall-clock bounds or null),
     * reason ('legacy' | a reason key | null), pattern (an escaped LIKE or null),
     * money_account ('531' | '532' | null), direction ('in' | 'out' | null), limit,
     * offset, today ('YYYY-MM-DD', Beirut) }. Totals are over every row the filters
     * match. The opening safe balance is not a row (it never moves the till): its block
     * is `safe_opening` (safeOpeningState).
     */
    static async listCorrections(database_id, q) {
        const chart = await correctionChart(pool);
        const a531 = chart.id("531");
        const a532 = chart.id("532");
        if (a531 === null || a532 === null) throw new Error("Chart account 531 / 532 not found");

        const params = [a531, a532, a531, a532, a531, a532, a531, a532, a531, a532];
        const where = ["jv.database_id = ?", "jv.is_deleted = 0"];
        params.push(database_id);
        if (q.reason === "legacy") where.push(LIST_WHERE.legacy);
        else if (q.reason) {
            where.push(LIST_WHERE.reason);
            params.push(CORRECTION_REASONS[q.reason].prefix);
        } else where.push(LIST_WHERE.any);
        if (q.lo) {
            where.push(LIST_WHERE.from);
            params.push(q.lo);
        }
        if (q.hi) {
            where.push(LIST_WHERE.to);
            params.push(q.hi);
        }
        if (q.pattern) {
            where.push(LIST_WHERE.search);
            params.push(q.pattern, q.pattern);
        }
        const having = [];
        if (q.money_account) {
            having.push(LIST_HAVING.money);
            params.push(chart.id(q.money_account));
        }
        if (q.direction) having.push(LIST_HAVING[q.direction]);

        const inner = `${LIST_SELECT}
WHERE ${where.join(" AND ")}
${LIST_GROUP}${having.length ? `\nHAVING ${having.join(" AND ")}` : ""}`;

        const [[count]] = await pool.query(
            `/* rk:corrections.count */ SELECT COUNT(*) AS n,
       ROUND(SUM(CASE WHEN t.till_change > 0 THEN t.till_change ELSE 0 END),2) AS into_till,
       ROUND(SUM(CASE WHEN t.till_change < 0 THEN -t.till_change ELSE 0 END),2) AS out_of_till
FROM (${inner}) t`,
            params,
        );
        const [rows] = await pool.query(
            `/* rk:corrections.list */ ${inner}
ORDER BY jv.journal_date DESC, jv.journal_id DESC
LIMIT ? OFFSET ?`,
            [...params, q.limit, q.offset],
        );

        const intoC = toCents(count?.into_till ?? null);
        const outC = toCents(count?.out_of_till ?? null);
        const till = await BalanceModel.tillBalance(pool, chart, database_id);
        const safe_opening = await BalanceModel.safeOpeningState(pool, chart, database_id, q.today);
        return {
            set_up: Object.values(CORRECTION_REASONS).every((r) => chart.id(r.account) !== null),
            total: Number(count?.n ?? 0),
            totals: {
                into_till: toMoney(intoC),
                out_of_till: toMoney(outC),
                net: toMoney(intoC - outC),
            },
            balance: till.balance,
            safe_opening,
            reasons: Object.entries(CORRECTION_REASONS).map(([key, r]) => ({
                reason: key,
                direction: r.direction,
                account: r.account,
                journal_prefix: r.prefix,
                available: chart.id(r.account) !== null,
            })),
            rows: rows.map((row) => {
                const journalId = Number(row.journal_id);
                const kind = kindOf(row.journal_number, journalId);
                const tillC = toCents(row.till_change ?? null);
                const direction = tillC > 0 ? "in" : "out";
                const counter = chart.number(row.counter_id);
                const editable =
                    kind !== null &&
                    Number(row.line_count) === 2 &&
                    Number(row.money_lines) === 1 &&
                    Number(row.odd_lines) === 0 &&
                    tillC !== 0 &&
                    Math.abs(tillC) === toCents(row.total_value) &&
                    counter === (kind ? counterOf(kind) : null) &&
                    (kind === "legacy" || CORRECTION_REASONS[kind].direction === direction);
                return {
                    journal_id: journalId,
                    journal_number: String(row.journal_number),
                    date: String(row.journal_date),
                    reason: kind ? listReasonOf(kind, direction) : null,
                    direction,
                    money_account: chart.number(row.money_id),
                    amount: toMoney(Math.abs(tillC)),
                    notes:
                        (kind === "legacy" ? row.journal_description : row.line_notes) ?? null,
                    account: counter,
                    editable,
                };
            }),
        };
    }

    static async getBalanceByUserId(userId) {
        const [_531] = await Account.getIdByAccountNumber("531");
        const query = `SELECT COALESCE(sum(debit) - sum(credit),0) AS balance 
        FROM journal_items ji
        where ji.is_deleted = 0
        AND ji.account_id_fk = ?
        AND ji.database_id = ?;`;
        const [[rows]] = await pool.query(query, [_531.id, userId]);

        return rows;
    }

    static async getAllUsersBalance() {
        const [_531] = await Account.getIdByAccountNumber("531");
        const query = `SELECT u.database_id , COALESCE(sum(ji.debit) - sum(ji.credit),0) AS balance 
            FROM users u
            LEFT JOIN journal_items ji  ON u.database_id = ji.database_id
            AND ji.is_deleted = 0
            AND ji.account_id_fk = ?
            GROUP BY u.database_id;`;
        const [rows] = await pool.query(query, [_531.id]);
        return rows;
    }

    // Same receiver list as Transfer.getTransferAccounts, and the same reason for the
    // explicit columns: another tenant's user_database settings are never served.
    static async getTransferAccounts(database_id) {
        const query = `SELECT d.database_id, CONCAT(u.first_name, ' ', u.last_name) AS full_name FROM user_database d
        INNER JOIN users u ON d.database_id = u.database_id
        WHERE u.user_type != 'staff' AND u.is_deleted = 0 AND u.database_id != ?`;
        const [rows] = await pool.query(query, [database_id]);
        return rows;
    }

    // get cash transaction history
    static async getCashTransactions(start, end, database_id, accountNumber) {
        const [account] = await Account.getIdByAccountNumber(accountNumber);

        let query = `WITH partner_balance AS (
            SELECT
                SUM(CASE WHEN ji.debit IS NOT NULL THEN ji.debit ELSE 0 END) AS debit,
                SUM(CASE WHEN ji.credit IS NOT NULL THEN ji.credit ELSE 0 END) AS credit
            FROM
                journal_items ji
            INNER JOIN
                journal_vouchers jv ON ji.journal_id_fk = jv.journal_id
            WHERE
                ji.account_id_fk = ?
                AND Date(jv.journal_date) < ?
                AND ji.database_id = ?
                AND ji.is_deleted = 0
        )
        SELECT
            NULL AS journal_date,
            NULL AS journal_datetime,
            NULL AS journal_number,
            'Initial Balance' AS journal_description,
            COALESCE(pb.debit, 0) AS debit,
            COALESCE(pb.credit, 0) AS credit,
			NULL as notes,

            COALESCE(pb.debit, 0) - COALESCE(pb.credit, 0) AS balance
        FROM
            partner_balance pb

        UNION
        (
        SELECT
        DATE(jv.journal_date) AS journal_date,
        jv.journal_date AS journal_datetime,
        jv.journal_number,
        jv.journal_description,
        ji.debit,
        ji.credit,
		ji.notes,
        NULL AS balance
        FROM
        journal_items ji
        INNER JOIN
        journal_vouchers jv ON jv.journal_id = ji.journal_id_fk
        WHERE
        ji.account_id_fk  = ?
        AND DATE(jv.journal_date) BETWEEN ? AND ?
        AND ji.is_deleted = 0
        AND ji.database_id = ?
        )
        ORDER BY
        journal_datetime ASC`;

        const [rows] = await pool.query(query, [
            account.id,
            start,
            database_id,
            account.id,
            start,
            end,
            database_id,
        ]);
        return rows;
    }

    // self transfer
    static async selfTransfer(database_id, data) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            moment.tz.setDefault("Asia/Beirut");
            const transfer_date = moment().format(`YYYY-MM-DD HH:mm:ss`);

            //insert to vouchers and journal_items
            let query = `INSERT INTO journal_vouchers ( database_id, journal_date, journal_description, total_value) VALUES (?, ?, ?, ?)`;
            const [journal_voucher] = await connection.query(query, [
                database_id,
                transfer_date,
                `Self Transfer`,
                data.amount,
            ]);

            // cash account
            const [cashAccount] = await Account.getIdByAccountNumber("531");

            // whish account
            const [whishAccount] = await Account.getIdByAccountNumber("532");

            let cashAccountEntry = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: transfer_date,
                account_id_fk: cashAccount.id,
            };

            let whishAccountEntry = {
                database_id: database_id,
                journal_id_fk: journal_voucher.insertId,
                journal_date: transfer_date,
                account_id_fk: whishAccount.id,
            };

            // if transaction is from cash to whish
            if (data.from_account == 531) {
                cashAccountEntry.credit = data.amount;
                cashAccountEntry.notes = `Cash To Whish`;

                whishAccountEntry.debit = data.amount;
                whishAccountEntry.notes = `Cash To Whish`;
            } else {
                // else transaction is from whish to cash
                cashAccountEntry.debit = data.amount;
                cashAccountEntry.notes = `Whish To Cash`;

                whishAccountEntry.credit = data.amount;
                whishAccountEntry.notes = `Whish To Cash`;
            }

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                cashAccountEntry,
            );

            await connection.query(
                `INSERT INTO journal_items SET ?`,
                whishAccountEntry,
            );

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = BalanceModel;
