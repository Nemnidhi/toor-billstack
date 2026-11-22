import { useState } from "react";
import { downloadDocumentBlob, removeDocumentRequest, uploadDocumentRequest } from "../../features/accounting/api";

// Documents on a purchase bill, expense or supplier (bills, receipts, rent agreements with their
// validity). PDF / JPG / PNG up to 5 MB; files are only readable by signed-in users of the business.
const KIND_LABEL = { BILL: "Bill", AGREEMENT: "Agreement", RECEIPT: "Receipt", CERTIFICATE: "Certificate", OTHER: "Other" };
const field = "rounded-xl border bg-transparent px-3 py-1.5 text-xs";
const themed = { borderColor: "var(--panel-border)" };
const muted = { color: "var(--text-muted)" };
const day = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");

const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });

const DocumentsPanel = ({ recordType, recordId, documents = [], defaultKind = "BILL", kinds = ["BILL", "RECEIPT", "OTHER"], canRemove = true }) => {
  const [items, setItems] = useState(documents);
  const [file, setFile] = useState(null);
  const [kind, setKind] = useState(defaultKind);
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const upload = async () => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError("The file is larger than 5 MB"); return; }
    setBusy(true); setError("");
    try {
      const fileBase64 = await readBase64(file);
      const saved = await uploadDocumentRequest(recordType, recordId, { fileBase64, fileName: file.name, kind, validFrom: validFrom || undefined, validTo: validTo || undefined });
      setItems((current) => [...current, saved]);
      setFile(null); setValidFrom(""); setValidTo("");
    } catch (err) {
      setError(err?.response?.data?.message || err.message);
    } finally { setBusy(false); }
  };

  const open = async (item) => {
    try {
      const blob = await downloadDocumentBlob(recordType, recordId, item._id);
      const url = URL.createObjectURL(new Blob([blob], { type: item.mimeType }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { setError(err?.response?.data?.message || err.message); }
  };

  const remove = async (item) => {
    if (!window.confirm(`Take ${item.fileName} off this record? The edit log keeps a note of it.`)) return;
    try { await removeDocumentRequest(recordType, recordId, item._id); setItems((current) => current.filter((d) => d._id !== item._id)); }
    catch (err) { setError(err?.response?.data?.message || err.message); }
  };

  return (
    <div className="mt-3 rounded-xl border p-3 text-left" style={themed}>
      <p className="text-xs font-semibold">Documents</p>
      {items.length ? (
        <ul className="mt-2 space-y-1">
          {items.map((item) => {
            const ended = item.validTo && new Date(item.validTo) < new Date();
            return (
              <li key={item._id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase" style={{ ...themed, ...muted }}>{KIND_LABEL[item.kind] || item.kind}</span>
                <button type="button" className="text-sky-600 underline dark:text-sky-300" onClick={() => open(item)}>{item.fileName}</button>
                {item.validTo ? <span className={ended ? "text-rose-500" : ""} style={ended ? undefined : muted}>{item.validFrom ? `${day(item.validFrom)} to ` : "until "}{day(item.validTo)}{ended ? " (ended)" : ""}</span> : null}
                {canRemove ? <button type="button" className="text-rose-500" onClick={() => remove(item)}>Remove</button> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="mt-1 text-xs" style={muted}>No documents yet.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" className="max-w-[220px] text-xs" onChange={(e) => setFile(e.target.files?.[0] || null)} aria-label="Choose a document" />
        <select className={field} style={themed} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Document type">
          {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        {kind === "AGREEMENT" ? (
          <>
            <input type="date" className={field} style={themed} value={validFrom} onChange={(e) => setValidFrom(e.target.value)} aria-label="Valid from" />
            <input type="date" className={field} style={themed} value={validTo} onChange={(e) => setValidTo(e.target.value)} aria-label="Valid to" />
          </>
        ) : null}
        <button type="button" disabled={!file || busy} onClick={upload} className="rounded-xl bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{busy ? "Uploading..." : "Attach"}</button>
      </div>
      {error ? <p className="mt-1 text-xs text-rose-500">{error}</p> : null}
    </div>
  );
};

export default DocumentsPanel;
