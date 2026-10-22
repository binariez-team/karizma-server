const express = require("express");
const router = express.Router();
const { owner } = require("../middleware/auth");

const PartnerShareController = require("../controllers/PartnerShare.controller");

// Partner shares taken (plan §8 Phase 7.1 part D). Mounted as /partner-shares behind
// `auth` (index.js). Every route: `owner` first (any staff token → 403 before any SQL),
// then the live users row (PartnerShareController.loadViewer: 401 "Please log in
// again." when it no longer matches the token). The handlers check the role:
// a user records and withdraws his own entries; the admin reviews every shop's.
router.use(owner, PartnerShareController.loadViewer);

router.post("/", PartnerShareController.create);
router.post("/search", PartnerShareController.search);
router.get("/pending-count", PartnerShareController.pendingCount);
router.patch("/:share_id/approve", PartnerShareController.approve);
router.patch("/:share_id/reject", PartnerShareController.reject);
router.post("/:share_id/reverse", PartnerShareController.reverse);
router.delete("/:share_id", PartnerShareController.remove);

module.exports = router;
