const mongoose = require("mongoose");

const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(mongoUri);
  console.log("MongoDB connected");
  await ensureBusinessIndexes();
};

/**
 * 23 Nov 2026: the old unique index on (billingParentId, billingEntityCode) covered every child
 * business, so a group could hold only one business without a code. It is replaced by one that
 * covers coded children only (see models/Business.js); drop the old one once and build the new.
 */
const ensureBusinessIndexes = async () => {
  const Business = require("../models/Business");
  const OLD = "billingParentId_1_billingEntityCode_1";
  try {
    const existing = await Business.collection.indexes();
    if (existing.some((index) => index.name === OLD)) {
      await Business.collection.dropIndex(OLD);
      console.log(`Dropped old index businesses.${OLD}`);
    }
  } catch (error) {
    if (error.codeName !== "NamespaceNotFound") throw error;
  }
  await Business.createIndexes();
};

module.exports = connectDB;
module.exports.ensureBusinessIndexes = ensureBusinessIndexes;

