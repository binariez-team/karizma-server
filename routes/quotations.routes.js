const express = require("express");
const router = express.Router();

const QuotationController = require("../controllers/QuotationController");

router.post("", QuotationController.create);
router.post("/search", QuotationController.search);
router.get("/:id/items", QuotationController.getItems);
router.get("/:id", QuotationController.getById);
router.put("/:id", QuotationController.update);
router.delete("/:id", QuotationController.remove);

module.exports = router;
