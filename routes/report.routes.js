const express = require("express");
const router = express.Router();

const ReportController = require("../controllers/Reports.controller");

router.get("/total-sales/:start/:end", ReportController.getTotalSales);

router.get("/stock-value", ReportController.getStockValue);

// top sales and categories
router.get("/categories/:start&:end", ReportController.getTopCategories);
router.get("/top-sales/:start&:end&:id", ReportController.getTopSales);

// expenses
router.get("/expenses/:start&:end", ReportController.getExpenses);

// revenues and returns and disposes
router.get("/revenue/:start&:end", ReportController.getRevenue);
router.get("/returns/:start&:end", ReportController.getReturns);
router.get("/disposes/:start&:end", ReportController.getDisposes);

// total orders
router.get("/total-orders/:start&:end", ReportController.getTotalOrders);

// debts
router.get("/debts/:start&:end", ReportController.getDebts);

// customer payments
router.get(
	"/customer-payments/:start&:end",
	ReportController.getCustomerPayments
);

// supplier payments
router.get(
	"/supplier-payments/:start&:end",
	ReportController.getSupplierPayments
);

// get manual cash transactions
router.get(
	"/manual-cash/:start&:end",
	ReportController.getManualCashTransactions
);

// cash balance
router.get("/cash/:start&:end", ReportController.getCashBalance);

module.exports = router;
