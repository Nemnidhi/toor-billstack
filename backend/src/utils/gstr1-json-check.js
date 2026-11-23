const policy = require("../../../shared/gst-policy.cjs");

// Checks a GSTR-1 JSON against the rules the GST offline tool and portal apply on upload, before the
// accountant uploads it. GSTN publishes no formal schema: the field names follow the offline tool's
// own export, and the rules below are the portal's validations (formats, lengths, rates, the tax split
// for the place of supply, Table 12 split into B2B / B2C from May 2025, Table 13 mandatory from May
// 2025, totals that must tie between tables). Final proof is still opening the file in the latest
// offline tool. Answers [{ level: "error" | "warning", where, message }].

// Rates the portal accepts (GST 2.0 from 22 Sep 2025 adds 40; 12 / 28 stay for earlier periods).
const RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);
const UQC = new Set("BAG BAL BDL BKL BOU BOX BTL BUN CAN CBM CCM CMS CTN DOZ DRM GGK GMS GRS GYD KGS KLR KME LTR MLT MTR MTS NOS OTH PAC PCS PRS QTL ROL SET SQF SQM SQY TBS TGM THD TON TUB UGS UNT YDS NA".split(" "));
const INV_TYPES = new Set(["R", "SEWP", "SEWOP", "DE", "CBW"]);
const NIL_TYPES = new Set(["INTRB2B", "INTRAB2B", "INTRB2C", "INTRAB2C"]);
const B2CL_LIMIT = 100000;
const TOLERANCE = 1; // the portal allows a rupee of rounding between tax and rate x value

const isPos = (code) => /^\d{2}$/.test(String(code || "")) && (policy.validState(code) || ["96", "97"].includes(code));
const isDocNumber = (value) => /^[A-Za-z0-9/-]{1,16}$/.test(String(value || "")) && !/^[0/-]+$/.test(String(value));
const parseDate = (value) => {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return date.getUTCDate() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 ? date : null;
};
const isMoney = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const sum = (rows, pick) => Math.round(rows.reduce((total, row) => total + Number(pick(row) || 0), 0) * 100) / 100;

const checkGstr1Json = (json = {}) => {
  const issues = [];
  const add = (level, where, message) => issues.push({ level, where, message });
  const own = String(json.gstin || "").slice(0, 2);

  if (!policy.validGstin(json.gstin)) add("error", "gstin", "Your GSTIN is missing or not valid (GST & Tax settings).");
  const fp = /^(0[1-9]|1[0-2])(\d{4})$/.exec(String(json.fp || ""));
  if (!fp) add("error", "fp", "Return period must be MMYYYY.");
  const periodEnd = fp ? new Date(Date.UTC(Number(fp[2]), Number(fp[1]), 0)) : null;

  // One rate line of an invoice or note: rate allowed, amounts with 2 decimals, the right tax heads.
  const checkItems = (where, itms, pos, { interOnly = false } = {}) => {
    if (!Array.isArray(itms) || !itms.length) return add("error", where, "No items.");
    const nums = new Set();
    for (const item of itms) {
      const d = item?.itm_det || {};
      if (nums.has(item?.num)) add("error", where, `Item number ${item?.num} repeats.`);
      nums.add(item?.num);
      if (!RATES.has(Number(d.rt))) add("error", where, `Rate ${d.rt}% is not a GST rate.`);
      for (const key of ["txval", "iamt", "camt", "samt", "csamt"]) if (d[key] !== undefined && !isMoney(d[key])) add("error", where, `${key} must be a number with at most 2 decimals.`);
      const inter = pos && own && pos !== own;
      if (inter || interOnly) {
        if (Number(d.camt || 0) || Number(d.samt || 0)) add("error", where, "Inter-state supply: IGST only, no CGST / SGST.");
        if (Math.abs(Number(d.iamt || 0) - Number(d.txval || 0) * Number(d.rt || 0) / 100) > TOLERANCE) add("error", where, `IGST ${d.iamt} is not ${d.rt}% of ${d.txval}.`);
      } else {
        if (Number(d.iamt || 0)) add("error", where, "Intra-state supply: CGST + SGST, no IGST.");
        if (Math.abs(Number(d.camt || 0) - Number(d.samt || 0)) > 0.01) add("error", where, "CGST and SGST must be equal.");
        if (Math.abs(Number(d.camt || 0) + Number(d.samt || 0) - Number(d.txval || 0) * Number(d.rt || 0) / 100) > TOLERANCE) add("error", where, `CGST + SGST is not ${d.rt}% of ${d.txval}.`);
      }
    }
  };
  const checkDate = (where, value) => {
    const date = parseDate(value);
    if (!date) return add("error", where, `Date ${value} must be dd-mm-yyyy.`);
    if (periodEnd && date > periodEnd) add("error", where, `Date ${value} is after the return period.`);
  };

  const numbers = new Map();
  const seeNumber = (where, number) => {
    if (!isDocNumber(number)) add("error", where, `Number "${number}": at most 16 letters, digits, / and -, and not all zeros.`);
    const key = String(number || "").toUpperCase();
    if (numbers.has(key)) add("error", where, `Number ${number} is reported twice (also in ${numbers.get(key)}).`);
    numbers.set(key, where);
  };

  for (const party of json.b2b || []) {
    if (!policy.validGstin(party.ctin)) add("error", `B2B ${party.ctin}`, "Customer GSTIN is not valid.");
    if (party.ctin === json.gstin) add("error", `B2B ${party.ctin}`, "An invoice to your own GSTIN.");
    for (const inv of party.inv || []) {
      const where = `B2B ${inv.inum}`;
      seeNumber(where, inv.inum);
      checkDate(where, inv.idt);
      if (!isPos(inv.pos)) add("error", where, `Place of supply ${inv.pos} is not a state code.`);
      if (!["Y", "N"].includes(inv.rchrg)) add("error", where, "Reverse charge must be Y or N.");
      if (!INV_TYPES.has(inv.inv_typ)) add("error", where, `Invoice type ${inv.inv_typ} is not one the portal knows.`);
      if (!isMoney(inv.val) || inv.val < sum(inv.itms || [], (i) => i.itm_det?.txval) - TOLERANCE) add("error", where, "Invoice value is missing or below its taxable value.");
      checkItems(where, inv.itms, inv.pos);
    }
  }
  for (const group of json.b2cl || []) {
    if (!isPos(group.pos) || group.pos === own) add("error", `B2CL ${group.pos}`, "B2CL is for inter-state supplies only.");
    for (const inv of group.inv || []) {
      const where = `B2CL ${inv.inum}`;
      seeNumber(where, inv.inum);
      checkDate(where, inv.idt);
      if (!(Number(inv.val) > B2CL_LIMIT)) add("error", where, `B2CL is for invoices above ₹${B2CL_LIMIT.toLocaleString("en-IN")}; this one belongs in B2CS.`);
      checkItems(where, inv.itms, group.pos, { interOnly: true });
    }
  }
  const b2csKeys = new Set();
  for (const row of json.b2cs || []) {
    const where = `B2CS ${row.pos} ${row.rt}%`;
    if (!isPos(row.pos)) add("error", where, "Place of supply is not a state code.");
    if (row.sply_ty !== (row.pos === own ? "INTRA" : "INTER")) add("error", where, "Supply type does not match the place of supply.");
    if (row.typ !== "OE") add("error", where, "Type must be OE (no e-commerce operator).");
    const key = `${row.pos}|${row.rt}|${row.sply_ty}`;
    if (b2csKeys.has(key)) add("error", where, "Repeated: one row per place of supply and rate.");
    b2csKeys.add(key);
    checkItems(where, [{ num: 1, itm_det: row }], row.pos);
  }
  for (const party of json.cdnr || []) {
    if (!policy.validGstin(party.ctin)) add("error", `CDNR ${party.ctin}`, "Customer GSTIN is not valid.");
    for (const note of party.nt || []) {
      const where = `CDNR ${note.nt_num}`;
      seeNumber(where, note.nt_num);
      checkDate(where, note.nt_dt);
      if (!["C", "D"].includes(note.ntty)) add("error", where, "Note type must be C or D.");
      if (!isPos(note.pos)) add("error", where, "Place of supply is not a state code.");
      checkItems(where, note.itms, note.pos);
    }
  }
  for (const note of json.cdnur || []) {
    const where = `CDNUR ${note.nt_num}`;
    seeNumber(where, note.nt_num);
    checkDate(where, note.nt_dt);
    if (!["B2CL", "EXPWP", "EXPWOP"].includes(note.typ)) add("error", where, "Type must be B2CL, EXPWP or EXPWOP.");
    if (!["C", "D"].includes(note.ntty)) add("error", where, "Note type must be C or D.");
    checkItems(where, note.itms, note.pos, { interOnly: note.typ === "B2CL" });
  }
  for (const row of json.nil?.inv || []) if (!NIL_TYPES.has(row.sply_ty)) add("error", "Nil / exempt", `Supply type ${row.sply_ty} is not one the portal knows.`);

  // Table 12: split into B2B and B2C (May 2025 on); codes from the portal's list, 4+ digits.
  const hsn = json.hsn || {};
  if (Array.isArray(hsn.data)) add("error", "HSN", "Table 12 must come as hsn_b2b and hsn_b2c (the single list was replaced in 2025).");
  const hasB2b = (json.b2b || []).length || (json.cdnr || []).length;
  const hasB2c = (json.b2cl || []).length || (json.b2cs || []).length || (json.cdnur || []).length;
  if (hasB2b && !(hsn.hsn_b2b || []).length) add("error", "HSN", "B2B supplies are reported, so Table 12's B2B tab cannot be empty.");
  if (hasB2c && !(hsn.hsn_b2c || []).length) add("error", "HSN", "B2C supplies are reported, so Table 12's B2C tab cannot be empty.");
  for (const [tab, rows] of [["B2B", hsn.hsn_b2b || []], ["B2C", hsn.hsn_b2c || []]]) {
    const seen = new Set();
    for (const row of rows) {
      const where = `HSN ${tab} ${row.hsn_sc} ${row.rt}%`;
      if (!/^\d{4,8}$/.test(String(row.hsn_sc || ""))) add("error", where, "HSN / SAC must be 4 to 8 digits.");
      else if (String(row.hsn_sc).length < 6) add("warning", where, "Only 4 digits: enough below ₹5 crore turnover, 6 needed above it.");
      if (!UQC.has(row.uqc)) add("error", where, `Unit ${row.uqc} is not a portal unit (UQC).`);
      if (/^99/.test(String(row.hsn_sc)) && row.uqc !== "NA") add("error", where, "Services (SAC 99...) take unit NA.");
      if (!RATES.has(Number(row.rt))) add("error", where, `Rate ${row.rt}% is not a GST rate.`);
      if (seen.has(`${row.hsn_sc}|${row.rt}`)) add("error", where, "Repeated: one row per code and rate.");
      seen.add(`${row.hsn_sc}|${row.rt}`);
    }
  }
  // Table 12 ties to the invoice tables (the portal compares them).
  const txval = (items) => sum(items, (i) => i.itm_det?.txval);
  const b2bValue = sum(json.b2b || [], (p) => sum(p.inv || [], (inv) => txval(inv.itms || []))) - sum(json.cdnr || [], (p) => sum(p.nt || [], (n) => (n.ntty === "D" ? -1 : 1) * txval(n.itms || [])));
  const b2cValue = sum(json.b2cl || [], (g) => sum(g.inv || [], (inv) => txval(inv.itms || []))) + sum(json.b2cs || [], (r) => r.txval) - sum(json.cdnur || [], (n) => (n.ntty === "D" ? -1 : 1) * txval(n.itms || []));
  const hsnB2b = sum(hsn.hsn_b2b || [], (r) => r.txval);
  const hsnB2c = sum(hsn.hsn_b2c || [], (r) => r.txval);
  if (Math.abs(hsnB2b - b2bValue) > TOLERANCE) add("warning", "HSN B2B", `Table 12 B2B taxable value ${hsnB2b.toFixed(2)} differs from B2B less B2B notes ${b2bValue.toFixed(2)}.`);
  if (Math.abs(hsnB2c - b2cValue) > TOLERANCE) add("warning", "HSN B2C", `Table 12 B2C taxable value ${hsnB2c.toFixed(2)} differs from B2CL + B2CS less unregistered notes ${b2cValue.toFixed(2)}.`);

  // Table 13 (documents issued): mandatory from May 2025.
  const docs = json.doc_issue?.doc_det || [];
  if ((json.b2b || []).length + (json.b2cl || []).length + (json.b2cs || []).length && !docs.length) add("error", "Documents issued", "Table 13 (documents issued) is mandatory.");
  for (const block of docs) {
    for (const row of block.docs || []) {
      const where = `Documents ${block.doc_typ} ${row.from}-${row.to}`;
      if (!row.from || !row.to) add("error", where, "Series needs a from and a to number.");
      if (Number(row.net_issue) !== Number(row.totnum) - Number(row.cancel)) add("error", where, "Net issued must be total less cancelled.");
    }
  }
  return issues;
};

module.exports = { checkGstr1Json, RATES };
