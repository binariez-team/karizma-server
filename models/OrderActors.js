// Who prepared and who last edited a sales invoice, a return or a delivery.
//
// Migration (run manually, BEFORE deploying the server that writes these columns):
// ALTER TABLE sales_orders
//     ADD COLUMN created_by_user_id INT NULL,
//     ADD COLUMN updated_by_user_id INT NULL;
// ALTER TABLE return_orders
//     ADD COLUMN created_by_user_id INT NULL,
//     ADD COLUMN updated_by_user_id INT NULL;
// ALTER TABLE deliver_orders
//     ADD COLUMN created_by_user_id INT NULL,
//     ADD COLUMN updated_by_user_id INT NULL;
// Both hold users.user_id (admin, user or staff). No FK: users are soft-deleted, and
// an old document must keep naming whoever made it. NULL on rows from before the
// columns existed, which the screens and print show as nothing.
//
// Both are written from the caller's token only. The order rows are inserted with
// `SET ?` from request bodies, so every create and edit sets BOTH keys explicitly:
// a body key MySQL resolves to the same column (e.g. CREATED_BY_USER_ID — column
// names are case-insensitive) then fails the INSERT as "specified twice" instead of
// overriding the value.

// users.user_id from the token (signed as a string), or null
const actorId = (user) => {
    const id = Number(user?.user_id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// Stamp an order row built from a request body, before its `SET ?` INSERT. An array
// is refused: mysql2 binds its first element to `SET ?`, so keys set on the array
// itself would never reach the row (DeliverModel.create has the same check).
const stampActors = (order, created_by_user_id, updated_by_user_id) => {
    if (!order || typeof order !== "object" || Array.isArray(order)) {
        throw new Error("Invalid order");
    }
    order.created_by_user_id = created_by_user_id;
    order.updated_by_user_id = updated_by_user_id;
    return order;
};

// "First Last" (either part may be missing), else the username. Joined live rather
// than snapshotted, so a renamed user shows the new name on old documents too.
const nameOf = (u) =>
    `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', TRIM(${u}.first_name), TRIM(${u}.last_name))), ''), ${u}.username)`;

// Select-list columns, paired with actorJoins() on the same query. Only the two
// names leave the users table — never its other columns.
const ACTOR_COLUMNS = `${nameOf("PBU")} AS prepared_by_name,
                ${nameOf("EBU")} AS edited_by_name`;

// LEFT JOIN: no user (old rows) gives null names; a deleted user is still named.
const actorJoins = (orderAlias) =>
    `LEFT JOIN users PBU ON PBU.user_id = ${orderAlias}.created_by_user_id
            LEFT JOIN users EBU ON EBU.user_id = ${orderAlias}.updated_by_user_id`;

module.exports = { actorId, stampActors, ACTOR_COLUMNS, actorJoins };
