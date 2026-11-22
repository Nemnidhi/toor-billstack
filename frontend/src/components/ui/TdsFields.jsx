// TDS types (mirror of backend constants/tds.js) and the small form pieces that use them.
export const TDS_KINDS = [
  { key: "RENT_BUILDING", label: "Rent - building / office (194-I(b), 10%)", rate: 10 },
  { key: "RENT_PLANT", label: "Rent - plant / equipment (194-I(a), 2%)", rate: 2 },
  { key: "CONTRACTOR_INDIVIDUAL", label: "Contractor - individual / HUF (194C, 1%)", rate: 1 },
  { key: "CONTRACTOR_OTHER", label: "Contractor - company / firm (194C, 2%)", rate: 2 },
  { key: "PROFESSIONAL", label: "Professional fees (194J(b), 10%)", rate: 10 },
  { key: "TECHNICAL", label: "Technical services (194J(a), 2%)", rate: 2 },
  { key: "COMMISSION", label: "Commission / brokerage (194H, 2%)", rate: 2 },
];

export const TdsKindSelect = ({ value, onChange, className = "field", emptyLabel = "No TDS" }) => (
  <select value={value || ""} onChange={(event) => onChange(event.target.value)} className={className}>
    <option value="">{emptyLabel}</option>
    {TDS_KINDS.map((kind) => <option key={kind.key} value={kind.key}>{kind.label}</option>)}
  </select>
);

// On a receipt: what the customer kept back as TDS. The invoice is settled by the money plus this.
export const ReceiptTdsFields = ({ form, setForm }) => (
  <>
    <label>
      <span className="mb-2 block text-sm font-medium">TDS deducted by customer</span>
      <input type="number" min="0" step="0.01" value={form.tdsAmount || ""} onChange={(event) => setForm((value) => ({ ...value, tdsAmount: event.target.value }))} placeholder="0" className="field" />
    </label>
    <label>
      <span className="mb-2 block text-sm font-medium">TDS section</span>
      <TdsKindSelect value={form.tdsKind} onChange={(tdsKind) => setForm((value) => ({ ...value, tdsKind }))} emptyLabel="Pick if TDS was deducted" />
    </label>
  </>
);
