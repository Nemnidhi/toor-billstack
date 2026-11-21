const mongoose = require("mongoose");

// The books' edit log (audit trail, Companies (Accounts) Rules 3(1)): every create, change and
// delete of a book record, with the values before and after, who did it and when. It cannot be
// switched off, changed or deleted from the app, and nothing expires it (keep at least 8 years).
const change = new mongoose.Schema(
  {
    path: { type: String, required: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", default: null, index: true },
    model: { type: String, required: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    recordLabel: { type: String, default: "" },
    action: { type: String, enum: ["CREATE", "UPDATE", "DELETE"], required: true },
    changes: { type: [change], default: [] },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null }, // the whole record on create / delete
    update: { type: mongoose.Schema.Types.Mixed, default: null }, // the update sent, when values were not read
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    userEmail: { type: String, default: "" },
    userName: { type: String, default: "" },
    ip: { type: String, default: "" },
    requestId: { type: String, default: "" },
    at: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false }
);

schema.index({ businessId: 1, at: -1 });
schema.index({ businessId: 1, model: 1, at: -1 });

const refuse = function () {
  throw new Error("The edit log cannot be changed or deleted");
};
schema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"], refuse);
schema.pre("deleteOne", { document: true, query: false }, refuse);
schema.pre("save", function () {
  if (!this.isNew) throw new Error("The edit log cannot be changed or deleted");
});

module.exports = mongoose.model("EditLog", schema);
