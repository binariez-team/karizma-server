const express = require("express");
const router = express.Router();

const UserHistoryController = require("../controllers/UserHistoryController");

router.get("/deliver/pending", UserHistoryController.fetchPendingInvoices);
router.post("/deliver/search", UserHistoryController.fetchDeliverHistory);
router.put("/deliver/approve", UserHistoryController.approvePendingInvoice);
// shared by admin + user deliver lists; scoped to sender or receiver in the model
router.get("/deliver/:order_id/items", UserHistoryController.fetchDeliverItems);

// options for the received list's user filter (the caller's senders)
router.get(
    "/received-deliveries/senders",
    UserHistoryController.fetchReceivedDeliverySenders
);
router.post(
    "/received-deliveries/search",
    UserHistoryController.fetchReceivedDeliveries
);

router.post(
    "/money-transfer/search",
    UserHistoryController.fetchUserMoneyTransferHistory
);

module.exports = router;
