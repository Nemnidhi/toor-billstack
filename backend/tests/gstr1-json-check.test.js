// The GSTR-1 JSON checked against the portal's upload rules (no database).
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkGstr1Json } = require("../src/utils/gstr1-json-check");

const OWN = "23CGZPB7175E1Z5";
const CUSTOMER = "23AABCT1234C1Z5";
const item = (txval, rt, { inter = false } = {}) => ({ num: 1, itm_det: { txval, rt, iamt: inter ? Math.round(txval * rt) / 100 : 0, camt: inter ? 0 : Math.round(txval * rt / 2) / 100, samt: inter ? 0 : Math.round(txval * rt / 2) / 100, csamt: 0 } });
const good = () => ({
  gstin: OWN,
  fp: "102026",
  b2b: [{ ctin: CUSTOMER, inv: [{ inum: "TOOR/26-27/0001", idt: "05-10-2026", val: 11800, pos: "23", rchrg: "N", inv_typ: "R", itms: [item(10000, 18)] }] }],
  b2cl: [{ pos: "27", inv: [{ inum: "TOOR/26-27/0002", idt: "06-10-2026", val: 141600, itms: [item(120000, 18, { inter: true })] }] }],
  b2cs: [{ sply_ty: "INTRA", pos: "23", typ: "OE", txval: 5000, rt: 18, iamt: 0, camt: 450, samt: 450, csamt: 0 }],
  hsn: {
    hsn_b2b: [{ num: 1, hsn_sc: "997212", desc: "", uqc: "NA", qty: 0, txval: 10000, iamt: 0, camt: 900, samt: 900, csamt: 0, rt: 18 }],
    hsn_b2c: [{ num: 1, hsn_sc: "997212", desc: "", uqc: "NA", qty: 0, txval: 125000, iamt: 21600, camt: 450, samt: 450, csamt: 0, rt: 18 }],
  },
  doc_issue: { doc_det: [{ doc_num: 1, doc_typ: "Invoices for outward supply", docs: [{ num: 1, from: "TOOR/26-27/0001", to: "TOOR/26-27/0003", totnum: 3, cancel: 0, net_issue: 3 }] }] },
});
const errors = (json) => checkGstr1Json(json).filter((row) => row.level === "error");

test("a well-formed return passes", () => {
  assert.deepEqual(errors(good()), []);
  assert.deepEqual(checkGstr1Json(good()).filter((row) => row.level === "warning"), []);
});

test("the portal's format rules are caught", () => {
  const json = good();
  json.b2b[0].inv[0].inum = "TOOR/2026-27/INV/00001"; // 22 characters
  json.b2b[0].inv[0].idt = "2026-10-05";
  json.b2b[0].inv[0].itms[0].itm_det.iamt = 1800; // IGST on an intra-state invoice
  json.b2cl[0].inv[0].val = 90000; // below the B2CL limit
  json.b2cs[0].sply_ty = "INTER";
  json.hsn.hsn_b2b[0].uqc = "OTH"; // a service needs NA
  json.hsn.hsn_b2c[0].rt = 13;
  delete json.doc_issue;
  const messages = errors(json).map((row) => `${row.where}: ${row.message}`).join("\n");
  assert.match(messages, /at most 16/);
  assert.match(messages, /dd-mm-yyyy/);
  assert.match(messages, /no IGST/);
  assert.match(messages, /B2CL is for invoices above/);
  assert.match(messages, /Supply type does not match/);
  assert.match(messages, /take unit NA/);
  assert.match(messages, /13% is not a GST rate/);
  assert.match(messages, /Table 13/);
});

test("Table 12 must be split, the B2B tab filled when B2B is reported, and tie to the invoices", () => {
  const json = good();
  json.hsn = { data: json.hsn.hsn_b2c };
  const messages = errors(json).map((row) => row.message).join("\n");
  assert.match(messages, /hsn_b2b and hsn_b2c/);
  assert.match(messages, /B2B tab cannot be empty/);

  const off = good();
  off.hsn.hsn_b2c[0].txval = 120000;
  assert.ok(checkGstr1Json(off).some((row) => row.level === "warning" && /differs/.test(row.message)));
});

test("a number used twice and a date after the period are errors", () => {
  const json = good();
  json.b2cl[0].inv[0].inum = "TOOR/26-27/0001";
  json.b2cl[0].inv[0].idt = "02-11-2026";
  const messages = errors(json).map((row) => row.message).join("\n");
  assert.match(messages, /reported twice/);
  assert.match(messages, /after the return period/);
});
