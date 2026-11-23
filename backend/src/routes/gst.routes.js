const express = require("express");
const { summary, gstr1, gstr1Excel } = require("../controllers/gst.controller");
const auth = require("../middlewares/auth.middleware");
const tenant = require("../middlewares/tenant.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const { permit } = require("../middlewares/role.middleware");
const gstIn = require("../controllers/gst-input.controller");

const r = express.Router();
r.use(auth, tenant, requireActiveSubscription());
r.get("/summary", summary);
r.get("/gstr1", permit("owner", "admin", "accountant"), gstr1);
r.get("/gstr1/export", permit("owner", "admin", "accountant"), gstr1Excel);
// Buying side and GSTR-3B (books phase 3)
const books = permit("owner", "admin", "accountant");
r.get("/gstr1/json", books, gstIn.gstr1Json);
r.get("/gstr1/json/check", books, gstIn.gstr1JsonCheck);
r.get("/itc", books, gstIn.itcRegister);
r.post("/2b/import", books, gstIn.import2b);
r.get("/2b/match", books, gstIn.match2b);
r.post("/2b/rows/:rowId/ims", books, gstIn.setImsAction);
r.get("/gstr3b", books, gstIn.gstr3b);
r.get("/rcm/:expenseId/documents", books, gstIn.rcmDocuments);
module.exports = r;
