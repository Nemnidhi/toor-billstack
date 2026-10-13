const Business = require("../models/Business");
const User = require("../models/User");
const AppError = require("../utils/appError");
const { hashPassword } = require("./auth.service");
const { getDeploymentMode } = require("../constants/modules");
const { ensureSelfHostedBusinessProfile } = require("./self-hosted-profile.service");
const { startTrialForNewBusiness } = require("./commercial-plan.service");

/**
 * Creates a brand-new, empty client workspace (its own Business) with one owner account.
 *
 * Every client, invoice, payment and setting is scoped by businessId, so the new owner
 * starts with no data and can never see another workspace's records. Staff that the new
 * owner adds from their Team page belong to their workspace only.
 */

const slugify = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 40) || "workspace";

const uniqueSlug = async (name) => {
  const base = slugify(name);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = `${base}${attempt ? `-${Math.random().toString(36).slice(2, 6)}` : ""}`.slice(0, 48);
    // eslint-disable-next-line no-await-in-loop
    if (!(await Business.exists({ slug: candidate }))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 48);
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateWorkspaceInput = ({ businessName, ownerName, ownerEmail, password }) => {
  const errors = {};
  if (!String(businessName || "").trim() || String(businessName).trim().length < 2) errors.businessName = "Enter the company name";
  if (!String(ownerName || "").trim() || String(ownerName).trim().length < 2) errors.ownerName = "Enter the owner's name";
  if (!EMAIL.test(String(ownerEmail || "").trim())) errors.ownerEmail = "Enter a valid email";
  if (String(password || "").length < 8) errors.password = "Password must be at least 8 characters";
  return errors;
};

const createClientWorkspace = async ({ businessName, ownerName, ownerEmail, password, phone = "" }) => {
  const errors = validateWorkspaceInput({ businessName, ownerName, ownerEmail, password });
  if (Object.keys(errors).length) throw new AppError("Please fix the highlighted fields", 400, { fieldErrors: errors });

  const email = String(ownerEmail).trim().toLowerCase();
  // Sign-in is by email, so one email must belong to exactly one workspace owner.
  if (await User.exists({ email })) {
    throw new AppError(`${email} already has a BillStack account. Use a different email for this client.`, 409, { fieldErrors: { ownerEmail: "Already used by another account" } });
  }

  const deploymentMode = getDeploymentMode();
  let business = await Business.create({
    name: String(businessName).trim(),
    slug: await uniqueSlug(businessName),
    email,
    phone: String(phone || "").trim(),
    deploymentMode,
  });

  let owner;
  try {
    owner = await User.create({
      businessId: business._id,
      name: String(ownerName).trim(),
      email,
      password: await hashPassword(password),
      role: "owner",
      isActive: true,
      passwordChangedAt: new Date(),
    });
    business.ownerUserId = owner._id;
    await business.save();
    business = await ensureSelfHostedBusinessProfile(business);
    await startTrialForNewBusiness({ businessId: business._id, trialSource: "super_admin" });
  } catch (error) {
    // Never leave a half-created workspace behind.
    if (owner) await User.deleteOne({ _id: owner._id }).catch(() => {});
    await Business.deleteOne({ _id: business._id }).catch(() => {});
    throw error;
  }

  return {
    business: { id: business._id, name: business.name, slug: business.slug, deploymentMode: business.deploymentMode },
    owner: { id: owner._id, name: owner.name, email: owner.email, role: owner.role },
  };
};

module.exports = { createClientWorkspace, validateWorkspaceInput };
