const express = require("express");
const router = express.Router();

const { owner } = require("../middleware/auth");
const SellOrdersController = require("../controllers/SellOrdersController");
//orders
router.post("", SellOrdersController.addOrder);
router.put("", SellOrdersController.editOrder);

// invoices flagged "needs review" at checkout — the database owner's (admin/user)
// review queue; staff get 403
router.get("/review/count", owner, SellOrdersController.reviewCount);
router.post("/review/search", owner, SellOrdersController.reviewSearch);
router.patch("/review/:order_id", owner, SellOrdersController.markReviewed);

router.get("/:id/payment", SellOrdersController.getOrderPayment);
router.delete("/:id", SellOrdersController.deleteOrder);

module.exports = router;
