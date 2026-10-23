const asyncHandler=require("../utils/asyncHandler");const Invoice=require("../models/Invoice");const Purchase=require("../models/Purchase");
const { reportDateRange } = require("../utils/report-date-range");
const summarize=(rows)=>rows.reduce((s,row)=>{const g=row.gstSnapshot||row.gstBreakup||{};for(const k of ["cgst","sgst","utgst","igst","taxableValue"])s[k]+=Number(g[k]||0);return s;},{cgst:0,sgst:0,utgst:0,igst:0,taxableValue:0});
const summary=asyncHandler(async(req,res)=>{const businessId=req.tenant.businessId;const dates=reportDateRange(req.query);const [invoices,purchases]=await Promise.all([Invoice.find({businessId,status:{$ne:"cancelled"},gstSnapshot:{$ne:null},...(Object.keys(dates).length?{invoiceDate:dates}:{})}).select("gstBreakup gstSnapshot"),Purchase.find({businessId,status:{$ne:"cancelled"},gstSnapshot:{$ne:null},...(Object.keys(dates).length?{purchaseDate:dates}:{})}).select("gstBreakup gstSnapshot")]);const sales=summarize(invoices),purchase=summarize(purchases),hsn={};[...invoices,...purchases].forEach(row=>Object.entries(row.gstSnapshot?.hsnSacSummary||row.gstBreakup?.hsnSacSummary||{}).forEach(([k,v])=>hsn[k]=(hsn[k]||0)+Number(v)));res.json({data:{sales:{...sales,totalGst:sales.cgst+sales.sgst+sales.utgst+sales.igst},purchases:{...purchase,totalGst:purchase.cgst+purchase.sgst+purchase.utgst+purchase.igst},hsnSacSummary:hsn}})});
const { buildGstr1 } = require("../services/gstr1.service");
const { buildGstr1Workbook } = require("../utils/gstr1-excel");

// GSTR-1 preview for one month (?month=YYYY-MM): section rows, totals and a checklist.
const gstr1 = asyncHandler(async (req, res) => {
  res.json({ data: await buildGstr1({ businessId: req.tenant.businessId, month: req.query.month }) });
});

// Same data as the Tally / GST offline-tool Excel the CA files from.
const gstr1Excel = asyncHandler(async (req, res) => {
  const data = await buildGstr1({ businessId: req.tenant.businessId, month: req.query.month });
  const buffer = buildGstr1Workbook(data);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${data.fileName.replace(/[^A-Za-z0-9_.-]/g, "_")}"`);
  res.send(buffer);
});

module.exports = { summary, gstr1, gstr1Excel };
