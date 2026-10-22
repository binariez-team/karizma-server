const express = require("express");
const router = express.Router();
const { requirePermission } = require("../middleware/auth");

const {
    getAll,
    createTransfer,
    updateTransfer,
    deleteTransfer,
    getTransferAccounts,
    confirmTransfer,
} = require("../controllers/Transfer.controller");

// Sending money needs users.transfer_money (read live by requirePermission); admins
// always pass. The client offers "Transfer Money" (home) only with that flag, and the
// receiver list exists only for that dialog. Editing or deleting a sent, still pending
// transfer changes the money that leaves the shop, so it needs the same flag.
// The list (also the navbar badge, loaded for every login) and confirming an incoming
// transfer stay open: the client shows Confirm to anyone who sees the Transfers page,
// whatever transfer_money says.
router.get(
    "/accounts",
    requirePermission("transfer_money"),
    getTransferAccounts,
);
router.post("/search", getAll);

router.post("/", requirePermission("transfer_money"), createTransfer);
router.put(
    "/:transfer_id",
    requirePermission("transfer_money"),
    updateTransfer,
);
router.delete(
    "/:transfer_id",
    requirePermission("transfer_money"),
    deleteTransfer,
);

// confirm transfer
router.patch("/confirm/:transfer_id", confirmTransfer);

module.exports = router;
