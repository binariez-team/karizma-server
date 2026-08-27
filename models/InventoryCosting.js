/**
 * Shared weighted-average-cost movement.
 *
 * Stock value in this system is DERIVED — there is no value column. It is
 * `SUM(inventory_transactions.quantity) * inventory.avg_cost_usd`. So moving quantity
 * without touching the average implicitly values the movement at TODAY's average. That
 * is right for an outflow (relieving at the average leaves the average unchanged) but
 * wrong for a reversal, which has to put back exactly the value it took out — otherwise
 * every reversal leaks `quantity * (today_avg - recorded_cost)`.
 *
 * `applyValue` is the one place that arithmetic lives for the paths that need it.
 * `Dispose.model` and `UserStockModel` both drive dispose reversals and must agree, and
 * the same shape already appears inline in SellOrdersModel (edit + delete),
 * PurchaseModel (delete) and ReturnModel. Those predate this module and still carry
 * their own copies; they should migrate here when next touched.
 */
class InventoryCosting {
    /**
     * Blend value into (direction +1) or out of (direction -1) a product's pool.
     *
     * `entries` are `{ product_id, quantity, cost }` — quantity always positive, cost
     * being the per-unit value the movement should carry. Entries without a usable
     * quantity or cost are skipped rather than valued at zero, since a zero average is
     * read elsewhere as "never calculated".
     *
     * Must be called BEFORE the matching inventory_transactions rows are written or
     * removed: the blend has to see the quantity on hand without the units in question.
     */
    static async applyValue(connection, database_id, entries, direction) {
        // one product can appear on several lines of the same document — blend once
        const perProduct = new Map();
        for (const entry of entries) {
            const qty = Number(entry.quantity) || 0;
            const cost = Number(entry.cost) || 0;
            if (!(qty > 0) || !(cost > 0)) continue;
            const acc = perProduct.get(entry.product_id) || { qty: 0, value: 0 };
            acc.qty += qty;
            acc.value += qty * cost;
            perProduct.set(entry.product_id, acc);
        }

        // ascending product order keeps the lock order deterministic and matching the
        // other cost paths, so they cannot deadlock against each other
        const productIds = [...perProduct.keys()].sort((a, b) => a - b);

        for (const product_id of productIds) {
            const { qty, value } = perProduct.get(product_id);

            const [[inventoryRow]] = await connection.query(
                `SELECT avg_cost_usd FROM inventory
				WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0
				FOR UPDATE`,
                [product_id, database_id],
            );
            if (!inventoryRow) continue;

            const [[qtyRow]] = await connection.query(
                `SELECT COALESCE(SUM(quantity), 0) AS quantity
				FROM inventory_transactions
				WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                [product_id, database_id],
            );

            // mysql2 returns DECIMAL and SUM() over an INT column as strings — coerce
            // before any arithmetic, or `"5" + 1` becomes "51".
            const currentAvgCost = Number(inventoryRow.avg_cost_usd) || 0;
            // Stock is not checked on the way out, so on-hand can be negative. Clamp
            // before it reaches the divisor.
            const currentQty = Math.max(Number(qtyRow.quantity), 0);

            const newQty = currentQty + direction * qty;
            const newValue = currentQty * currentAvgCost + direction * value;

            // Nothing left to carry an average, or the pool is worth less than what is
            // being removed: leave the average alone rather than writing a negative or a
            // zero — PurchaseModel reads a 0.00 average as "never calculated".
            if (!(newQty > 0) || !(newValue > 0)) continue;

            // An empty (or unpriced) pool reopens at the incoming cost; the general form
            // reduces to exactly that anyway, but stating it avoids 0 * anything.
            const newAvgCost =
                currentQty === 0 || currentAvgCost === 0
                    ? value / qty
                    : newValue / newQty;

            // Round to the stored scale before the range check — avg_cost_usd is
            // DECIMAL(10,2), so the guard should see the value that actually lands.
            const rounded = Math.round(newAvgCost * 100) / 100;
            if (
                !Number.isFinite(rounded) ||
                rounded < 0.01 ||
                rounded > 99999999.99
            )
                continue;

            await connection.query(
                `UPDATE inventory SET avg_cost_usd = ?
				WHERE product_id_fk = ? AND database_id = ? AND is_deleted = 0`,
                [rounded, product_id, database_id],
            );
        }
    }

    /**
     * Current weighted average for a set of products, as a Map keyed by product_id.
     *
     * Needed when a document is REBUILT inside a transaction that has already moved the
     * average — a dispose edit restores the old lines first, so by the time the
     * replacement lines are written the pool is worth something different from whatever
     * the client captured when it opened the dialog. Storing the client's figure there
     * would record a cost that no longer matches the value actually relieved, and a
     * later reversal would then restore the wrong amount.
     */
    static async currentAverages(connection, database_id, productIds) {
        const ids = [...new Set(productIds)].filter((id) => id != null);
        const map = new Map();
        if (ids.length === 0) return map;
        const [rows] = await connection.query(
            `SELECT product_id_fk, avg_cost_usd FROM inventory
			WHERE product_id_fk IN (?) AND database_id = ? AND is_deleted = 0`,
            [ids, database_id],
        );
        for (const row of rows) {
            map.set(row.product_id_fk, Number(row.avg_cost_usd) || 0);
        }
        return map;
    }

    /**
     * Put the value of previously-disposed goods back, at the cost the dispose was
     * booked at. Used by both dispose implementations on edit and on delete.
     *
     * `dispose_products_items.unit_cost` is the per-unit cost captured when the dispose
     * was created, and it is the figure the loss report is built from — so restoring at
     * it keeps the stock value and the reported loss describing the same event, even
     * when the pool's average has moved since (51% of live dispose lines have).
     */
    static async restoreDisposedValue(connection, database_id, lines) {
        return InventoryCosting.applyValue(
            connection,
            database_id,
            lines.map((l) => ({
                product_id: l.product_id,
                quantity: l.quantity,
                cost: l.unit_cost,
            })),
            1,
        );
    }
}

module.exports = InventoryCosting;
