const pdfMake = require("pdfmake/build/pdfmake");
const pdfFonts = require("pdfmake/build/vfs_fonts");

pdfMake.vfs = pdfFonts;

// Management report PDF (client request, 23 Nov 2026: "report PDF export with pie charts and
// percentages"): the period's profit and loss with each head's share, where the money came from
// and went (pies), profit by centre, and the business line x category split. All figures come from
// the posted books (the same numbers as the Profit & Loss and Business lines screens).

const PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#94a3b8"];
const MAX_SLICES = 7; // the rest are joined as "Others"

const inr = (value) => {
  const n = Number(value || 0);
  const text = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}₹ ${text}`;
};
const pct = (part, whole) => (whole ? `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%` : "-");

/** Positive amounts only (a pie cannot show a loss), biggest first, the tail joined as "Others". */
const slicesOf = (rows) => {
  const positive = rows.filter((row) => Number(row.value) > 0).sort((a, b) => b.value - a.value);
  if (positive.length <= MAX_SLICES) return positive;
  const head = positive.slice(0, MAX_SLICES - 1);
  const rest = positive.slice(MAX_SLICES - 1).reduce((sum, row) => sum + row.value, 0);
  return [...head, { label: "Others", value: rest }];
};

/** A pie (donut) chart as SVG, for pdfmake's svg node. */
const pieSvg = (slices, size = 120) => {
  const total = slices.reduce((sum, row) => sum + row.value, 0);
  const r = size / 2 - 2;
  const c = size / 2;
  const inner = r * 0.55;
  if (!total) return null;
  let angle = -Math.PI / 2;
  const parts = slices.map((row, i) => {
    const colour = PALETTE[i % PALETTE.length];
    const share = row.value / total;
    if (share >= 0.9999) return `<circle cx="${c}" cy="${c}" r="${r}" fill="${colour}"/>`;
    const end = angle + share * Math.PI * 2;
    const large = share > 0.5 ? 1 : 0;
    const [x1, y1, x2, y2] = [c + r * Math.cos(angle), c + r * Math.sin(angle), c + r * Math.cos(end), c + r * Math.sin(end)];
    angle = end;
    return `<path d="M ${c} ${c} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${colour}" stroke="#ffffff" stroke-width="1"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${parts.join("")}<circle cx="${c}" cy="${c}" r="${inner}" fill="#ffffff"/></svg>`;
};

const swatch = (colour) => ({ canvas: [{ type: "rect", x: 0, y: 2, w: 8, h: 8, color: colour }], width: 12 });

/** A pie with its legend (label, amount, share). Rows: [{label, value}]. */
const pieBlock = (title, rows, note = "") => {
  const slices = slicesOf(rows);
  const total = slices.reduce((sum, row) => sum + row.value, 0);
  const svg = pieSvg(slices);
  const legend = slices.map((row, i) => ({
    columns: [swatch(PALETTE[i % PALETTE.length]), { text: row.label, width: "*" }, { text: inr(row.value), width: 100, alignment: "right" }, { text: pct(row.value, total), width: 45, alignment: "right", bold: true }],
    columnGap: 4,
    margin: [0, 1, 0, 1],
    fontSize: 8.5,
  }));
  return {
    stack: [
      { text: title, style: "h3" },
      svg
        ? { columns: [{ svg, width: 120 }, { stack: legend, width: "*", margin: [16, 8, 0, 0] }], columnGap: 8 }
        : { text: "Nothing to chart in this period.", style: "muted" },
      note ? { text: note, style: "muted", margin: [0, 4, 0, 0] } : "",
    ],
    margin: [0, 6, 0, 12],
    unbreakable: true,
  };
};

const table = (header, body, widths) => ({
  table: { headerRows: 1, widths, body: [header.map((h, i) => ({ text: h, style: "th", alignment: i ? "right" : "left" })), ...body] },
  layout: { hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3), vLineWidth: () => 0, hLineColor: () => "#cbd5e1", paddingTop: () => 3, paddingBottom: () => 3 },
  fontSize: 8.5,
  margin: [0, 2, 0, 12],
});
const cell = (text, opts = {}) => ({ text, alignment: "right", ...opts });

const amountOf = (row) => Number(row.amount ?? row.totalAmount ?? 0);

/**
 * pl: a Profit & Loss report (one company or the consolidated one).
 * matrixIncome / matrixProfit: business line x category reports (tag-matrix.service).
 */
const buildManagementReportDefinition = ({ pl, matrixIncome, matrixProfit, companies, generatedAt = new Date() }) => {
  const income = (pl.income?.accounts || []).map((a) => ({ label: a.name, value: amountOf(a) })).filter((a) => a.value !== 0);
  const expenses = (pl.expenses?.accounts || []).map((a) => ({ label: a.name, value: amountOf(a) })).filter((a) => a.value !== 0);
  const totalIncome = Number(pl.income?.total || 0);
  const totalExpenses = Number(pl.expenses?.total || 0);
  const net = Number(pl.netProfit || 0);
  const period = pl.period?.periodLabel || "";
  const kpi = (label, value, sub) => ({ stack: [{ text: label, style: "kpiLabel" }, { text: inr(value), style: "kpi" }, { text: sub, style: "muted" }], width: "*" });

  const content = [
    { text: "Management report", style: "h1" },
    { text: `${companies.join(", ")}  |  ${period}`, style: "muted", margin: [0, 0, 0, 10] },
    {
      columns: [
        kpi("Income", totalIncome, "posted to income heads"),
        kpi("Expenses", totalExpenses, totalIncome ? `${pct(totalExpenses, totalIncome)} of income` : ""),
        kpi(net >= 0 ? "Net profit" : "Net loss", net, totalIncome ? `margin ${pct(net, totalIncome)}` : ""),
      ],
      columnGap: 12,
      margin: [0, 0, 0, 12],
    },
    pieBlock("Where the income came from", income),
    pieBlock("Where the money went", expenses),

    { text: "Profit and loss by head", style: "h2" },
    table(
      ["Head", "Amount", "Share"],
      [
        [{ text: "Income", bold: true, colSpan: 3 }, "", ""],
        ...income.map((r) => [r.label, cell(inr(r.value)), cell(pct(r.value, totalIncome))]),
        [{ text: "Total income", bold: true }, cell(inr(totalIncome), { bold: true }), cell("100%", { bold: true })],
        [{ text: "Expenses", bold: true, colSpan: 3 }, "", ""],
        ...[...expenses].sort((a, b) => b.value - a.value).map((r) => [r.label, cell(inr(r.value)), cell(pct(r.value, totalExpenses))]),
        [{ text: "Total expenses", bold: true }, cell(inr(totalExpenses), { bold: true }), cell("100%", { bold: true })],
        [{ text: net >= 0 ? "Net profit" : "Net loss", bold: true }, cell(inr(net), { bold: true }), cell(totalIncome ? pct(net, totalIncome) : "-", { bold: true })],
      ],
      ["*", 110, 60],
    ),
  ];

  const centres = (pl.byCentre || []).filter((r) => r.income || r.expenses);
  if (centres.length > 1 || (centres.length === 1 && centres[0].label !== "Not assigned")) {
    content.push({ text: "Profit by centre / property", style: "h2" });
    content.push(table(
      ["Centre", "Income", "Expenses", "Profit", "Share of income"],
      centres.map((r) => [r.label, cell(inr(r.income)), cell(inr(r.expenses)), cell(inr(r.netProfit)), cell(pct(r.income, totalIncome))]),
      ["*", 85, 85, 85, 70],
    ));
  }

  const tagged = (m) => m && m.rows.some((r) => r.key !== m.notSetKey && r.total !== 0);
  if (tagged(matrixIncome) || tagged(matrixProfit)) {
    content.push({ text: "Business lines and categories", style: "h2", pageBreak: "before" });
    content.push(pieBlock("Income by business line", (matrixIncome?.rows || []).map((r) => ({ label: r.label, value: r.total }))));
    content.push(pieBlock("Income by category", (matrixIncome?.columns || []).map((c) => ({ label: c.label, value: c.total }))));
    for (const [label, m] of [["Profit", matrixProfit], ["Income", matrixIncome]]) {
      if (!m?.rows?.length) continue;
      content.push({ text: `${label}: business line x category`, style: "h3" });
      const widths = ["*", ...m.columns.map(() => 62), 70, 42];
      content.push(table(
        ["Business line", ...m.columns.map((c) => c.label), "Total", "Share"],
        [
          ...m.rows.map((r) => [r.label, ...r.cells.map((c) => cell(c.amount ? inr(c.amount) : "-")), cell(inr(r.total), { bold: true }), cell(`${r.percentOfTotal}%`)]),
          [{ text: "Total", bold: true }, ...m.columns.map((c) => cell(inr(c.total), { bold: true })), cell(inr(m.total), { bold: true }), cell("100%", { bold: true })],
        ],
        widths,
      ));
    }
  }

  content.push({ text: `From the posted books. Each share is of its own table's total; the pies show positive amounts only. Prepared ${generatedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.`, style: "muted", margin: [0, 8, 0, 0] });

  return {
    pageSize: "A4",
    pageMargins: [36, 40, 36, 40],
    content,
    defaultStyle: { fontSize: 9, color: "#0f172a" },
    styles: {
      h1: { fontSize: 18, bold: true },
      h2: { fontSize: 12, bold: true, margin: [0, 10, 0, 4] },
      h3: { fontSize: 10, bold: true, margin: [0, 2, 0, 4] },
      th: { bold: true, color: "#475569", fontSize: 8 },
      kpiLabel: { fontSize: 8, color: "#475569", bold: true },
      kpi: { fontSize: 14, bold: true, margin: [0, 2, 0, 1] },
      muted: { fontSize: 8, color: "#64748b" },
    },
    footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: "right", fontSize: 7, color: "#94a3b8", margin: [0, 10, 36, 0] }),
    info: { title: `Management report ${period}` },
  };
};

const buildManagementReportPdf = (args) =>
  new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(buildManagementReportDefinition(args)).getBuffer((buffer) => resolve(Buffer.from(buffer)));
    } catch (error) {
      reject(error);
    }
  });

module.exports = { buildManagementReportPdf, buildManagementReportDefinition, pieSvg, slicesOf };
