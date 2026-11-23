import { useEffect, useState } from "react";
import { Archive, Layers, Plus, RotateCcw } from "lucide-react";
import api from "../../api/axios";
import { authStore } from "../../store/authStore";

const KINDS = [
  { key: "businessLines", title: "Business lines", hint: "The vertical split, e.g. Workspace, TOOR, Enterprise.", placeholder: "e.g. Workspace" },
  { key: "categories", title: "Categories", hint: "The horizontal split, e.g. C1, C2, C3.", placeholder: "e.g. C1" },
];

// The group's business lines and categories. One list for every company in the group, so the
// business line x category report lines up across them. A name in use is archived, never
// deleted or renamed (posted books keep the name they were saved with).
export default function ReportingTagsSettings() {
  const user = authStore((s) => s.user);
  const canEdit = ["owner", "admin"].includes(user?.role);
  const [lists, setLists] = useState(null);
  const [drafts, setDrafts] = useState({ businessLines: "", categories: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canEdit) return;
    api.get("/business/reporting-tags").then((r) => setLists(r.data.data)).catch((e) => setError(e.response?.data?.message || "Unable to load the lists"));
  }, [canEdit]);

  if (!canEdit) return null;

  const save = async (next) => {
    setBusy(true);
    setError("");
    try {
      const response = await api.put("/business/reporting-tags", { businessLines: next.businessLines, categories: next.categories });
      setLists(response.data.data);
      window.dispatchEvent(new Event("billstack-tags-changed"));
      return true;
    } catch (e) {
      setError(e.response?.data?.message || "Unable to save");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (kind) => {
    const name = drafts[kind].replace(/\s+/g, " ").trim();
    if (!name) return;
    if (await save({ ...lists, [kind]: [...lists[kind], { name, archived: false }] })) setDrafts((d) => ({ ...d, [kind]: "" }));
  };
  const toggle = (kind, name) => save({ ...lists, [kind]: lists[kind].map((row) => (row.name === name ? { ...row, archived: !row.archived } : row)) });

  return (
    <section className="panel space-y-5 p-5 sm:p-6" aria-label="Business lines and categories">
      <div className="flex items-start gap-3">
        <span className="icon-chip"><Layers size={18} /></span>
        <div>
          <h2 className="text-base font-bold">Business lines & categories</h2>
          <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
            Tag invoices, expenses, purchases and recurring billing with a business line and a category, then see both together in
            Accounting &gt; Business lines. One list for every business in the group. To rename, archive the old name and add the new one; old entries keep theirs.
          </p>
        </div>
      </div>

      {lists ? (
        <div className="grid gap-4 md:grid-cols-2">
          {KINDS.map((kind) => (
            <div key={kind.key} className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}>
              <p className="text-sm font-semibold">{kind.title}</p>
              <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{kind.hint}</p>
              <ul className="mt-3 space-y-1.5">
                {lists[kind.key].length ? lists[kind.key].map((row) => (
                  <li key={row.name} className="flex items-center justify-between gap-2 text-sm">
                    <span className={row.archived ? "line-through" : "font-medium"} style={row.archived ? { color: "var(--text-muted)" } : undefined}>{row.name}</span>
                    <button type="button" className="btn-ghost" disabled={busy} onClick={() => toggle(kind.key, row.name)} aria-label={`${row.archived ? "Bring back" : "Archive"} ${row.name}`}>
                      {row.archived ? <><RotateCcw size={14} /> Bring back</> : <><Archive size={14} /> Archive</>}
                    </button>
                  </li>
                )) : <li className="text-xs" style={{ color: "var(--text-muted)" }}>None yet.</li>}
              </ul>
              <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); add(kind.key); }}>
                <input className="field flex-1" value={drafts[kind.key]} maxLength={60} placeholder={kind.placeholder} onChange={(e) => setDrafts((d) => ({ ...d, [kind.key]: e.target.value }))} aria-label={`New ${kind.title.toLowerCase()}`} />
                <button type="submit" className="btn-primary" disabled={busy || !drafts[kind.key].trim()}><Plus size={16} /> Add</button>
              </form>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p role="alert" className="alert alert-error">{error}</p> : null}
    </section>
  );
}
