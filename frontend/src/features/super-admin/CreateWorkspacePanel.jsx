import { useState } from "react";
import { superAdminCreateWorkspaceRequest } from "./api";

const blank = { businessName: "", ownerName: "", ownerEmail: "", phone: "", password: "" };

// Readable but strong: no look-alike characters.
const generatePassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const pick = (set) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const body = Array.from({ length: 9 }, () => pick(chars)).join("");
  return `${body.slice(0, 5)}${pick("@#$%&*")}${body.slice(5)}${pick("23456789")}`;
};

const inputClass = "field";

/**
 * Developer tool: give a new client their own empty BillStack company with an owner login.
 * Nothing from any other workspace is visible to them.
 */
const CreateWorkspacePanel = ({ onCreated }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);

  const start = () => { setForm({ ...blank, password: generatePassword() }); setErrors({}); setMessage(""); setCreated(null); setOpen(true); };
  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true); setErrors({}); setMessage("");
    try {
      const result = await superAdminCreateWorkspaceRequest(form);
      setCreated({ ...result, password: form.password });
      setOpen(false);
      onCreated?.(result);
    } catch (error) {
      setErrors(error.response?.data?.errors || {});
      setMessage(error.response?.data?.message || "Unable to create the workspace.");
    } finally {
      setSaving(false);
    }
  };

  const loginUrl = `${window.location.origin}/login`;
  const shareText = created ? `BillStack login\nCompany: ${created.business.name}\nLink: ${loginUrl}\nEmail: ${created.owner.email}\nPassword: ${created.password}` : "";

  return (
    <section className="panel p-6" style={{ color: "var(--text-primary)" }}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Client workspaces</h2>
          <p className="mt-2 max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
            Give a new client their own company in BillStack with an owner login. It starts empty: no clients, invoices or settings from anyone else, and their staff only ever see their own company.
          </p>
        </div>
        {!open ? <button type="button" onClick={start} className="btn-primary shrink-0">+ Create client workspace</button> : null}
      </div>

      {open ? (
        <form onSubmit={submit} className="mt-5 grid gap-4 md:grid-cols-2">
          {[
            ["businessName", "Company name", "text", "e.g. Sharma Realty Pvt Ltd"],
            ["ownerName", "Owner's name", "text", "Person who will log in"],
            ["ownerEmail", "Owner's email (login)", "email", "client@example.com"],
            ["phone", "Phone (optional)", "text", ""],
          ].map(([field, label, type, placeholder]) => (
            <label key={field} className="block">
              <span className="form-label mb-1.5 block">{label}</span>
              <input type={type} value={form[field]} onChange={update(field)} placeholder={placeholder} className={inputClass} required={field !== "phone"} />
              {errors[field] ? <span className="form-error mt-1 block">{errors[field]}</span> : null}
            </label>
          ))}
          <label className="block md:col-span-2">
            <span className="form-label mb-1.5 block">Owner's password</span>
            <div className="flex gap-2">
              <input type="text" value={form.password} onChange={update("password")} className={`${inputClass} font-mono`} required minLength={8} />
              <button type="button" onClick={() => setForm((current) => ({ ...current, password: generatePassword() }))} className="btn-secondary">Generate</button>
            </div>
            {errors.password ? <span className="form-error mt-1 block">{errors.password}</span> : <span className="form-hint mt-1 block">They can change it later from their Team page.</span>}
          </label>
          {message ? <p role="alert" className="alert alert-error md:col-span-2">{message}</p> : null}
          <div className="flex gap-3 md:col-span-2">
            <button type="submit" disabled={saving} className="btn-primary">{saving ? "Creating…" : "Create workspace"}</button>
            <button type="button" onClick={() => setOpen(false)} className="btn-secondary">Cancel</button>
          </div>
        </form>
      ) : null}

      {created ? (
        <div role="status" className="alert alert-success mt-5 block">
          <p className="font-semibold">{created.business.name} is ready. Send these login details to the client:</p>
          <pre className="mt-3 whitespace-pre-wrap rounded-xl border p-3 font-mono text-xs" style={{ background: "var(--panel-bg)", color: "var(--text-primary)", borderColor: "var(--panel-border)" }}>{shareText}</pre>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(shareText); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }} className="btn-primary">{copied ? "Copied" : "Copy login details"}</button>
            <button type="button" onClick={() => setCreated(null)} className="btn-secondary">Done</button>
          </div>
          <p className="mt-2 text-xs font-normal">This password is not shown again. Ask the client to change it after their first login.</p>
        </div>
      ) : null}
    </section>
  );
};

export default CreateWorkspacePanel;
