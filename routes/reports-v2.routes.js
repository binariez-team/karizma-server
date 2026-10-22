const express = require("express");
const router = express.Router();

const ReportsV2Controller = require("../controllers/ReportsV2Controller");

// Mounted as /reports/v2 behind `auth` and middleware/reportsAccess.js (index.js).
// Each phase of the reports plan adds its own endpoints here.
router.get("/tenants", ReportsV2Controller.tenants);
// Phase 2
router.post("/inventory", ReportsV2Controller.inventory);
router.post("/lookups", ReportsV2Controller.lookups);
// Phase 3
router.post("/overview", ReportsV2Controller.overview);
router.post("/financial", ReportsV2Controller.financial);
// Phase 4
router.post("/balance-sheet", ReportsV2Controller.balanceSheet);
// Phase 5
router.post("/products/table", ReportsV2Controller.productsTable);
router.post("/products/rollup", ReportsV2Controller.productsRollup);
router.post("/product-history/lines", ReportsV2Controller.historyLines);
router.post("/product-history/product", ReportsV2Controller.historyProduct);
router.post("/product-history/ledger", ReportsV2Controller.historyLedger);
// Phase 6
router.post("/busy-hours", ReportsV2Controller.busyHours);

module.exports = router;
