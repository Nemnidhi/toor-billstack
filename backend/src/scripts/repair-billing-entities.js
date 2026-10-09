/* eslint-disable no-console */
/**
 * Repair duplicate billing companies and stale entity-access grants.
 *
 *   node src/scripts/repair-billing-entities.js          # preview only (default)
 *   node src/scripts/repair-billing-entities.js --apply  # make the changes
 *
 * What it does:
 *  - In each company group, keeps one business per billing entity code (same rule the
 *    app uses: inside the group, then most invoices, then oldest). An extra copy is
 *    disabled only when it holds NO business data; otherwise it is reported for a
 *    manual merge and left untouched. Nothing is deleted except access grants.
 *  - Removes access grants that point to disabled/missing companies, to deleted or
 *    inactive users, or to a user's own home company (that access is automatic).
 */
require("../config/load-env")();
const mongoose = require("mongoose");
const Business = require("../models/Business");
const Membership = require("../models/BusinessMembership");
const User = require("../models/User");
const { pickCanonicalEntities } = require("../services/billing-entity.service");

const APPLY = process.argv.includes("--apply");
const DATA_MODELS = ["Invoice", "Customer", "Quote", "Payment", "Expense", "RecurringBillingProfile", "Product", "JournalEntry"];

const dataCounts = async (businessId) => {
  const counts = {};
  for (const name of DATA_MODELS) {
    try {
      counts[name] = await require(`../models/${name}`).countDocuments({ businessId });
    } catch {
      counts[name] = 0;
    }
  }
  return counts;
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(APPLY ? "MODE: APPLY (changes will be written)\n" : "MODE: PREVIEW (no changes; re-run with --apply)\n");

  const roots = await Business.find({ billingParentId: null, isDisabled: { $ne: true }, deploymentMode: "SELF_HOSTED" });
  const disabledIds = new Set();

  for (const root of roots) {
    const members = await Business.find({ $or: [{ _id: root._id }, { billingParentId: root._id }], isDisabled: { $ne: true } }).sort({ createdAt: 1, _id: 1 });
    const keep = new Set((await pickCanonicalEntities(members, { rootId: root._id })).map((row) => String(row._id)));
    const extras = members.filter((row) => !keep.has(String(row._id)));
    if (!extras.length) continue;

    console.log(`Company group "${root.name}" (${root._id}):`);
    for (const row of members.filter((r) => keep.has(String(r._id)))) console.log(`  keep     ${row.name} [${row.billingEntityCode || "-"}] ${row._id}`);
    for (const extra of extras) {
      const counts = await dataCounts(extra._id);
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      const summary = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(", ") || "no data";
      if (total > 0) {
        console.log(`  SKIP     ${extra.name} [${extra.billingEntityCode}] ${extra._id} has data (${summary}) - needs a manual merge, left as is`);
        continue;
      }
      console.log(`  disable  ${extra.name} [${extra.billingEntityCode}] ${extra._id} (${summary})`);
      disabledIds.add(String(extra._id));
      if (APPLY) await Business.updateOne({ _id: extra._id }, { $set: { isDisabled: true } });
    }
    console.log("");
  }

  const grants = await Membership.find({}).lean();
  const businesses = new Map((await Business.find({ _id: { $in: grants.map((g) => g.businessId) } }).select("isDisabled name").lean()).map((b) => [String(b._id), b]));
  const users = new Map((await User.find({ _id: { $in: grants.map((g) => g.userId) } }).select("businessId isActive name email").lean()).map((u) => [String(u._id), u]));

  const stale = [];
  for (const grant of grants) {
    const business = businesses.get(String(grant.businessId));
    const user = users.get(String(grant.userId));
    let reason = "";
    if (!business) reason = "company no longer exists";
    else if (business.isDisabled || disabledIds.has(String(grant.businessId))) reason = "company is a disabled duplicate";
    else if (!user) reason = "user no longer exists";
    else if (user.isActive === false) reason = "user is inactive";
    else if (String(user.businessId) === String(grant.businessId)) reason = "user's own home company (access is automatic)";
    if (reason) stale.push({ grant, reason, label: `${user?.name || "unknown user"} -> ${business?.name || grant.businessId}` });
  }

  console.log(`Access grants to remove: ${stale.length}`);
  stale.forEach(({ label, reason }) => console.log(`  remove   ${label}  (${reason})`));
  if (APPLY && stale.length) await Membership.deleteMany({ _id: { $in: stale.map(({ grant }) => grant._id) } });

  console.log(APPLY ? "\nDone." : "\nPreview finished. Nothing was changed.");
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
