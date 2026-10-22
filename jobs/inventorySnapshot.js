require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const cron = require("node-cron");
const moment = require("moment-timezone");
const pool = require("../config/database");

// Month-end stock snapshot (reports plan D16, §7.4, §8 Phase 1).
//
// There is no average-cost history: inventory.avg_cost_usd is overwritten on every
// purchase, delivery and revaluation, so a past stock value cannot be rebuilt. This job
// records, on the last day of every month at 23:55 Beirut, each tenant's on-hand
// quantity per product with its cost and three prices, into inventory_cost_snapshots.
// The balance sheet's month-end picker reads it later.
//
// - On-hand comes from the stock ledger, so stock without an inventory row is kept
//   (cost 0.00, prices NULL) and negative quantities are kept as recorded.
// - Cost and prices come from the latest live inventory row, or from the latest row of
//   any kind when none is live (a product delete flags every tenant's rows deleted);
//   such rows are flagged product_deleted.
// - INSERT IGNORE: the first write of a (date, tenant, product) wins.
// - A missed month is simply absent; nothing catches up.
// - Every query is a plain SELECT or an INSERT into the snapshot table; it never
//   throws, so the cron and the server are never taken down by it.
//
// Owner-only manual run (writes to the DB): node jobs/inventorySnapshot.js --now
// A forced run is stamped with TODAY's Beirut date. On the last day of the month that
// is the month-end date, and INSERT IGNORE would let it block the real 23:55 row, so a
// forced run that day is refused before 23:55 (after it, it stands in for a missed run).

const TZ = "Asia/Beirut";
const BATCH_SIZE = 500;

const READ_SQL = `/* rk:snapshot.read */
SELECT oh.database_id, oh.product_id_fk AS product_id, oh.q AS quantity,
       COALESCE(i.avg_cost_usd, 0)  AS avg_cost_usd,
       COALESCE(i.unit_cost_usd, 0) AS unit_cost_usd,
       i.unit_price_usd, i.whole_price_usd, i.grandwhole_price_usd,
       COALESCE(p.is_deleted, 1)    AS product_deleted
FROM (SELECT database_id, product_id_fk, SUM(quantity) AS q
      FROM inventory_transactions WHERE is_deleted = 0
      GROUP BY database_id, product_id_fk HAVING SUM(quantity) <> 0) oh
LEFT JOIN (SELECT product_id_fk, database_id,
                  COALESCE(MAX(CASE WHEN is_deleted = 0 THEN record_id END), MAX(record_id)) AS rid
           FROM inventory GROUP BY product_id_fk, database_id) ix
       ON ix.product_id_fk = oh.product_id_fk AND ix.database_id = oh.database_id
LEFT JOIN inventory i ON i.record_id = ix.rid
LEFT JOIN products  p ON p.product_id = oh.product_id_fk`;

const INSERT_SQL = `/* rk:snapshot.insert */ INSERT IGNORE INTO inventory_cost_snapshots
    (snapshot_date, database_id, product_id, quantity, avg_cost_usd, unit_cost_usd,
     unit_price_usd, whole_price_usd, grandwhole_price_usd, product_deleted, taken_at)
    VALUES ?`;

// true on the last day of the month (the cron also fires on the 28th–30th)
const isMonthEnd = (now) => now.clone().add(1, "day").date() === 1;

// the scheduled run's time, 23:55 Beirut
const beforeScheduledRun = (now) => now.hours() * 60 + now.minutes() < 23 * 60 + 55;

/**
 * Take the snapshot. Never rejects.
 *
 * @param {{ force?: boolean, now?: moment.Moment }} options
 *   force: run on any day, stamped with that day's date (owner's --now run), except
 *     on the last day of the month before 23:55, which is left to the scheduled run;
 *   now: the Beirut moment to act as (tests pass a fake clock).
 * @returns {Promise<{status: 'skipped'|'done'|'no_table'|'error',
 *   snapshot_date?: string, rows?: number}>}
 */
async function runSnapshot({ force = false, now = moment.tz(TZ) } = {}) {
    let connection;
    try {
        if (!force && !isMonthEnd(now)) return { status: "skipped" };
        if (force && isMonthEnd(now) && beforeScheduledRun(now)) {
            console.warn(
                "⚠️ Inventory snapshot not taken: today is the last day of the month, and the 23:55 run writes today's row. Run --now after 23:55 only if that run was missed.",
            );
            return { status: "skipped" };
        }

        const snapshot_date = now.format("YYYY-MM-DD");
        const taken_at = now.format("YYYY-MM-DD HH:mm:ss");

        const [rows] = await pool.query(READ_SQL);

        const values = rows.map((row) => [
            snapshot_date,
            Number(row.database_id),
            Number(row.product_id),
            Number(row.quantity), // SUM() arrives as a DECIMAL string
            row.avg_cost_usd,
            row.unit_cost_usd,
            row.unit_price_usd,
            row.whole_price_usd,
            row.grandwhole_price_usd,
            Number(row.product_deleted) ? 1 : 0, // boolean or number from the pool
            taken_at,
        ]);

        // One transaction: a month-end snapshot is either complete or absent, never a
        // partial set that would read as missing stock
        if (values.length) {
            connection = await pool.getConnection();
            await connection.beginTransaction();
            for (let i = 0; i < values.length; i += BATCH_SIZE) {
                await connection.query(INSERT_SQL, [values.slice(i, i + BATCH_SIZE)]);
            }
            await connection.commit();
        }

        console.log(
            `📦 Inventory snapshot ${snapshot_date}: ${values.length} rows written ✔`,
        );
        return { status: "done", snapshot_date, rows: values.length };
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                // the original error is the one worth reporting
            }
        }

        if (error?.code === "ER_NO_SUCH_TABLE") {
            console.warn(
                "⚠️ Inventory snapshot skipped: table inventory_cost_snapshots is missing (run the reports migration §7.4).",
            );
            return { status: "no_table" };
        }
        console.error("❌ Inventory snapshot failed:", error?.message || error);
        return { status: "error" };
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseError) {
                // never let the job reject
            }
        }
    }
}

function initInventorySnapshotCron() {
    console.log("🔁 Initializing inventory snapshot cron...");

    // 23:55 Beirut on the 28th–31st; runSnapshot itself only acts on the last day.
    // Not run at startup.
    cron.schedule("55 23 28-31 * *", () => runSnapshot(), {
        timezone: TZ,
    });

    console.log("🕒 Scheduled inventory snapshot job active ✔");
}

module.exports = initInventorySnapshotCron;
module.exports.runSnapshot = runSnapshot;
module.exports.isMonthEnd = isMonthEnd;

// Owner-only manual run: node jobs/inventorySnapshot.js [--now]
if (require.main === module) {
    runSnapshot({ force: process.argv.includes("--now") })
        .then((result) => {
            console.log("Inventory snapshot:", JSON.stringify(result));
            return pool.end().then(() => result);
        })
        .then((result) => {
            process.exit(["done", "skipped"].includes(result.status) ? 0 : 1);
        })
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
