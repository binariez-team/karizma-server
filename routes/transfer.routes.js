const express = require("express");
const router = express.Router();

const {
    getAll,
    createTransfer,
    updateTransfer,
    deleteTransfer,
    getTransferAccounts,
    confirmTransfer,
} = require("../controllers/Transfer.controller");

router.get("/accounts", getTransferAccounts);
router.post("/search", getAll);

router.post("/", createTransfer);
router.put("/:transfer_id", updateTransfer);
router.delete("/:transfer_id", deleteTransfer);

// confirm transfer
router.patch("/confirm/:transfer_id", confirmTransfer);

module.exports = router;
