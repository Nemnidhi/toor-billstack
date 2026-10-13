import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2, UserCheck, UserX, Users, X } from "lucide-react";
import PageHeader from "../../../components/ui/PageHeader";
import { ErrorState, LoadingState } from "../../../components/ui/PageState";
import { authStore } from "../../../store/authStore";
import { uiStore } from "../../../store/uiStore";
import {
  createTeamMemberRequest,
  deleteTeamMemberRequest,
  listTeamMembersRequest,
  updateTeamMemberRequest,
} from "../../auth/api";

const ROLES = [
  { value: "owner", label: "Owner", description: "Everything, including team, billing companies and settings." },
  { value: "admin", label: "Admin", description: "Runs the workspace: clients, invoices, team and most settings." },
  { value: "accountant", label: "Accountant", description: "Invoices, payments, expenses, reports and accounting." },
  { value: "staff", label: "Staff", description: "Day-to-day work like clients, quotations and invoices." },
];
const roleLabel = Object.fromEntries(ROLES.map((role) => [role.value, role.label]));
const roleTone = {
  owner: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  admin: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  accountant: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  staff: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
};

const blankForm = { name: "", email: "", password: "", role: "staff", isActive: true };

// Readable but strong: no look-alike characters (0/O, 1/l/I).
const generatePassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const symbols = "@#$%&*";
  const pick = (set) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const body = Array.from({ length: 9 }, () => pick(chars)).join("");
  return `${body.slice(0, 5)}${pick(symbols)}${body.slice(5)}${pick("23456789")}`;
};

const relativeTime = (value) => {
  if (!value) return "Never signed in";
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 2) return "Active just now";
  if (minutes < 60) return `Signed in ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Signed in ${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Signed in ${days} day${days === 1 ? "" : "s"} ago`;
  return `Signed in ${new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`;
};

const PasswordField = ({ value, onChange, label = "Password", hint, autoFocus = false }) => {
  const [visible, setVisible] = useState(true);
  return (
    <label className="form-field">
      <span className="form-label">{label}</span>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} className="field pr-10 font-mono" autoComplete="new-password" autoFocus={autoFocus} />
          <button type="button" onClick={() => setVisible((v) => !v)} aria-label={visible ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1" style={{ color: "var(--text-muted)" }}>
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <button type="button" onClick={() => onChange(generatePassword())} className="btn-secondary">Generate</button>
      </div>
      {hint ? <span className="form-hint">{hint}</span> : null}
    </label>
  );
};

const CopyButton = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn-secondary" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }}>
      {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy"}
    </button>
  );
};

const Modal = ({ title, onClose, children, width = "max-w-lg" }) => (
  <div className="modal-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label={title} className={`panel w-full ${width} p-5 shadow-2xl sm:p-6`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <h2 className="text-lg font-bold">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="btn-icon"><X size={18} /></button>
      </div>
      {children}
    </div>
  </div>
);

const TeamPage = () => {
  const { user } = authStore();
  const myId = String(user?.id || user?._id || "");
  const isOwner = user?.role === "owner";
  const canManageTeam = ["owner", "admin"].includes(user?.role);

  const [filters, setFilters] = useState({ page: 1, limit: 50, search: "", role: "", status: "", sortBy: "name", sortOrder: "asc" });
  const [result, setResult] = useState({ items: [], pagination: { page: 1, totalPages: 1, total: 0 } });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [editor, setEditor] = useState(null); // { mode: "new" | "edit", member }
  const [form, setForm] = useState(blankForm);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [passwordFor, setPasswordFor] = useState(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordResult, setPasswordResult] = useState(null); // { member, password } shown once after saving
  const [confirmRemove, setConfirmRemove] = useState(null);

  const loadTeam = async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      setResult(await listTeamMembersRequest(filters));
    } catch (error) {
      setLoadError(error.response?.data?.message || "Unable to load team members.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (canManageTeam) loadTeam();
    else setIsLoading(false);
  }, [canManageTeam, filters.page, filters.search, filters.role, filters.status]);

  const members = result.items || [];
  const stats = useMemo(() => ({
    total: result.pagination?.total ?? members.length,
    active: members.filter((m) => m.isActive !== false).length,
    managers: members.filter((m) => ["owner", "admin"].includes(m.role)).length,
    neverSignedIn: members.filter((m) => !m.lastLoginAt).length,
  }), [members, result.pagination]);

  const canEdit = (member) => isOwner || member.role !== "owner";
  const roleChoices = ROLES.filter((role) => isOwner || role.value !== "owner");
  const toast = (message, tone = "success") => uiStore.getState().pushToast({ tone, message });

  const openNew = () => { setForm({ ...blankForm, password: generatePassword() }); setErrors({}); setFormError(""); setEditor({ mode: "new" }); };
  const openEdit = (member) => { setForm({ name: member.name || "", email: member.email || "", password: "", role: member.role || "staff", isActive: member.isActive !== false }); setErrors({}); setFormError(""); setEditor({ mode: "edit", member }); };

  const saveMember = async (event) => {
    event.preventDefault();
    setSaving(true); setErrors({}); setFormError("");
    try {
      if (editor.mode === "edit") {
        await updateTeamMemberRequest(editor.member._id || editor.member.id, { name: form.name, email: form.email, role: form.role, isActive: form.isActive });
        toast(`${form.name} updated.`);
        setEditor(null);
      } else {
        await createTeamMemberRequest(form);
        setEditor(null);
        setPasswordResult({ member: { name: form.name, email: form.email }, password: form.password, created: true });
      }
      await loadTeam();
    } catch (error) {
      setErrors(error.response?.data?.errors || {});
      setFormError(error.response?.data?.message || "Unable to save team member.");
    } finally {
      setSaving(false);
    }
  };

  const savePassword = async (event) => {
    event.preventDefault();
    if (newPassword.length < 8) { setFormError("Use at least 8 characters."); return; }
    setSaving(true); setFormError("");
    try {
      await updateTeamMemberRequest(passwordFor._id || passwordFor.id, { password: newPassword });
      setPasswordResult({ member: passwordFor, password: newPassword });
      setPasswordFor(null);
      await loadTeam();
    } catch (error) {
      setFormError(error.response?.data?.message || "Unable to set the password.");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (member) => {
    try {
      await updateTeamMemberRequest(member._id || member.id, { isActive: member.isActive === false });
      toast(member.isActive === false ? `${member.name} can sign in again.` : `${member.name} can no longer sign in.`);
      await loadTeam();
    } catch (error) {
      toast(error.response?.data?.message || "Unable to change access.", "error");
    }
  };

  const removeMember = async () => {
    try {
      await deleteTeamMemberRequest(confirmRemove._id || confirmRemove.id);
      toast(`${confirmRemove.name} removed from the team.`);
      setConfirmRemove(null);
      await loadTeam();
    } catch (error) {
      toast(error.response?.data?.message || "Unable to remove team member.", "error");
    }
  };

  if (!canManageTeam) {
    return <ErrorState title="Owner or admin access required" description="Only owner and admin accounts can manage team members and roles." />;
  }

  return (
    <div className="mx-auto max-w-[1300px] space-y-5 pb-8">
      <PageHeader
        kicker="Admin"
        title="Team"
        description="Add people, choose what they can do, and reset their password if they get locked out."
        actions={<button type="button" onClick={openNew} className="btn-primary"><Plus size={17} /> Add member</button>}
      />

      <section className="stat-grid">
        {[["Team members", stats.total, Users], ["Active", stats.active, UserCheck], ["Owners & admins", stats.managers, ShieldCheck], ["Never signed in", stats.neverSignedIn, KeyRound]].map(([label, value, Icon]) => (
          <div key={label} className="panel stat-card">
            <div className="flex items-center justify-between"><p className="stat-label">{label}</p><Icon size={15} style={{ color: "var(--text-muted)" }} /></div>
            <p className="stat-value">{value}</p>
          </div>
        ))}
      </section>

      <section className="panel overflow-hidden">
        <div className="grid gap-3 border-b p-4 sm:grid-cols-[minmax(0,1fr)_170px_160px]" style={{ borderColor: "var(--panel-border)" }}>
          <label className="relative"><span className="sr-only">Search team</span><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--text-muted)" }} />
            <input value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, page: 1, search: e.target.value }))} placeholder="Search name or email" className="field pl-9" />
          </label>
          <select aria-label="Role" value={filters.role} onChange={(e) => setFilters((f) => ({ ...f, page: 1, role: e.target.value }))} className="field">
            <option value="">All roles</option>
            {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
          </select>
          <select aria-label="Status" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, page: 1, status: e.target.value }))} className="field">
            <option value="">Active & inactive</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
        </div>

        {isLoading ? <div className="p-6"><LoadingState title="Loading team" description="Fetching members and roles." /></div>
          : loadError ? <div className="p-6"><ErrorState title="Unable to load team members" description={loadError} /></div>
          : members.length ? (
            <ul>
              {members.map((member) => {
                const id = String(member._id || member.id);
                const isSelf = id === myId;
                const editable = canEdit(member);
                const inactive = member.isActive === false;
                const locked = member.lockedUntil && new Date(member.lockedUntil) > new Date();
                return (
                  <li key={id} className={`flex flex-col gap-3 border-b px-4 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between ${inactive ? "opacity-70" : ""}`} style={{ borderColor: "var(--panel-border)" }}>
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="customer-avatar" aria-hidden="true">{(member.name || "?").charAt(0).toUpperCase()}</span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-semibold">{member.name}{isSelf ? " (you)" : ""}</p>
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${roleTone[member.role] || roleTone.staff}`}>{roleLabel[member.role] || member.role}</span>
                          {inactive ? <span className="rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-semibold text-rose-700 dark:text-rose-300">Inactive</span> : null}
                          {locked ? <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">Locked: too many attempts</span> : null}
                        </div>
                        <p className="truncate text-sm" style={{ color: "var(--text-muted)" }}>{member.email}</p>
                        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                          {relativeTime(member.lastLoginAt)}
                          {member.passwordChangedAt ? ` · Password set ${new Date(member.passwordChangedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}` : ""}
                        </p>
                      </div>
                    </div>
                    {editable ? (
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        <button type="button" onClick={() => openEdit(member)} className="btn-secondary"><Pencil size={15} /> Edit</button>
                        <button type="button" onClick={() => { setPasswordFor(member); setNewPassword(generatePassword()); setFormError(""); }} className="btn-secondary"><KeyRound size={15} /> {isSelf ? "Change password" : "Set new password"}</button>
                        {!isSelf ? <button type="button" onClick={() => toggleActive(member)} className="btn-secondary">{inactive ? <><UserCheck size={15} /> Activate</> : <><UserX size={15} /> Deactivate</>}</button> : null}
                        {!isSelf ? <button type="button" onClick={() => setConfirmRemove(member)} aria-label={`Remove ${member.name}`} className="btn-danger"><Trash2 size={15} /></button> : null}
                      </div>
                    ) : <p className="text-xs" style={{ color: "var(--text-muted)" }}>Only the owner can change this account</p>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="p-6"><div className="empty-state"><span className="empty-state-icon"><Users size={22} /></span><p className="font-semibold">{filters.search || filters.role || filters.status ? "No one matches these filters" : "No team members yet"}</p><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Add your first admin, accountant or staff member.</p></div></div>
          )}
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold">What each role can do</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {ROLES.map((role) => (
            <div key={role.value} className="rounded-xl border p-3" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${roleTone[role.value]}`}>{role.label}</span>
              <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{role.description}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>Passwords are stored encrypted, so nobody (including admins) can read them. Use “Set new password” to give someone a new one.</p>
      </section>

      {editor ? (
        <Modal title={editor.mode === "edit" ? `Edit ${editor.member.name}` : "Add team member"} onClose={() => setEditor(null)}>
          <form onSubmit={saveMember} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="form-field"><span className="form-label">Full name</span><input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="field" autoFocus />{errors.name ? <span className="form-error">{errors.name}</span> : null}</label>
              <label className="form-field"><span className="form-label">Email (used to sign in)</span><input required type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="field" />{errors.email ? <span className="form-error">{errors.email}</span> : null}</label>
            </div>
            {editor.mode === "new" ? <PasswordField value={form.password} onChange={(password) => setForm((f) => ({ ...f, password }))} hint="You'll see it once more after saving so you can share it." /> : null}
            <fieldset>
              <legend className="form-label mb-2">Role</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {roleChoices.map((role) => (
                  <label key={role.value} className={`cursor-pointer rounded-xl border p-3 transition ${form.role === role.value ? "ring-2" : ""}`} style={{ borderColor: form.role === role.value ? "var(--accent)" : "var(--panel-border)", "--tw-ring-color": "var(--accent-ring)" }}>
                    <input type="radio" name="role" value={role.value} checked={form.role === role.value} onChange={() => setForm((f) => ({ ...f, role: role.value }))} className="sr-only" disabled={editor.mode === "edit" && String(editor.member._id || editor.member.id) === myId} />
                    <span className="text-sm font-semibold">{role.label}</span>
                    <span className="mt-0.5 block text-xs" style={{ color: "var(--text-muted)" }}>{role.description}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {editor.mode === "edit" && String(editor.member._id || editor.member.id) !== myId ? (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} /> Can sign in</label>
            ) : null}
            {formError ? <p role="alert" className="alert alert-error">{formError}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditor(null)} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary">{saving ? "Saving…" : editor.mode === "edit" ? "Save changes" : "Add member"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {passwordFor ? (
        <Modal title={String(passwordFor._id || passwordFor.id) === myId ? "Change your password" : `Set a new password for ${passwordFor.name}`} onClose={() => setPasswordFor(null)}>
          <form onSubmit={savePassword} className="space-y-4">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Their old password stops working right away and the account is unlocked if it was locked.</p>
            <PasswordField label="New password" value={newPassword} onChange={setNewPassword} hint="At least 8 characters." autoFocus />
            {formError ? <p role="alert" className="alert alert-error">{formError}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setPasswordFor(null)} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary"><KeyRound size={16} /> {saving ? "Saving…" : "Set password"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {passwordResult ? (
        <Modal title={passwordResult.created ? `${passwordResult.member.name} added` : "New password set"} onClose={() => setPasswordResult(null)}>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Share these sign-in details with {passwordResult.member.name} privately. This password won't be shown again.</p>
          <dl className="mt-4 space-y-2 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}>
            <div className="flex justify-between gap-3"><dt style={{ color: "var(--text-muted)" }}>Email</dt><dd className="font-semibold">{passwordResult.member.email}</dd></div>
            <div className="flex justify-between gap-3"><dt style={{ color: "var(--text-muted)" }}>Password</dt><dd className="font-mono font-semibold">{passwordResult.password}</dd></div>
          </dl>
          <div className="mt-4 flex justify-end gap-2">
            <CopyButton text={`Email: ${passwordResult.member.email}\nPassword: ${passwordResult.password}`} />
            <button type="button" onClick={() => setPasswordResult(null)} className="btn-primary">Done</button>
          </div>
        </Modal>
      ) : null}

      {confirmRemove ? (
        <Modal title={`Remove ${confirmRemove.name}?`} onClose={() => setConfirmRemove(null)} width="max-w-md">
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>They will lose access straight away. Invoices and records they created stay. To pause access instead, use Deactivate.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmRemove(null)} className="btn-secondary">Keep</button>
            <button type="button" onClick={removeMember} className="btn-primary bg-rose-600 hover:bg-rose-700"><Trash2 size={16} /> Remove</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default TeamPage;
