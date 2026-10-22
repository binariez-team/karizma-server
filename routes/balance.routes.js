const express = require("express");
const router = express.Router();
const { admin } = require("../middleware/auth");

const BalanceController = require("../controllers/BalanceController");

router.get("/", BalanceController.getBalance);
router.get("/user", BalanceController.getBalanceByUserId);
router.get("/all", admin, BalanceController.getAllUsersBalance);

// get cash transactions history
router.get(
    "/transactions/:start&:end&:account",
    BalanceController.getCashTransactions,
);

router.get("/transfer/accounts", BalanceController.getTransferAccounts);

router.post("/self-transfer", BalanceController.selfTransfer);

// The admin's cash corrections (2026-10-22, C1–C4): admin only, on his own tenant;
// `admin` refuses any other token before any SQL, loadAdmin re-reads the live login
const correction = [admin, BalanceController.loadAdmin];
router.post("/correct", ...correction, BalanceController.correctBalance);
router.get("/corrections", ...correction, BalanceController.listCorrections);
router.post("/corrections/reclassify", ...correction, BalanceController.reclassifyCorrections);
router.put("/corrections/:journal_id", ...correction, BalanceController.updateCorrection);
router.delete("/corrections/:journal_id", ...correction, BalanceController.deleteCorrection);
// Follow-ups F1 and F2 (2026-10-22), same gate: the correction history (audit trail) and
// the admin's one opening safe balance
router.get("/corrections/audit", ...correction, BalanceController.listCorrectionAudit);
router.post("/safe-opening", ...correction, BalanceController.createSafeOpening);
router.put("/safe-opening/:journal_id", ...correction, BalanceController.updateSafeOpening);
router.delete("/safe-opening/:journal_id", ...correction, BalanceController.deleteSafeOpening);

module.exports = router;
