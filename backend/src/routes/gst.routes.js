const express = require("express");
const { summary, gstr1, gstr1Excel } = require("../controllers/gst.controller");
const auth = require("../middlewares/auth.middleware");
const tenant = require("../middlewares/tenant.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const { permit } = require("../middlewares/role.middleware");

const r = express.Router();
r.use(auth, tenant, requireActiveSubscription());
r.get("/summary", summary);
r.get("/gstr1", permit("owner", "admin", "accountant"), gstr1);
r.get("/gstr1/export", permit("owner", "admin", "accountant"), gstr1Excel);
module.exports = r;
