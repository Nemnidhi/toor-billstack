import PageHeader from "../../../components/ui/PageHeader";
import { useEffect, useState } from "react";
import { BellRing, CalendarClock, CheckCircle2, CircleAlert, Mail, MessageCircle, RefreshCw, Send, Settings, Smartphone } from "lucide-react";
import { communicationDeliveriesRequest, communicationRulesRequest, communicationScheduledRequest, communicationSummaryRequest, communicationTemplatesRequest, createCommunicationRuleRequest, upsertCommunicationTemplateRequest } from "../../auth/api";
import { EmptyState, LoadingState } from "../../../components/ui/PageState";
import { uiStore } from "../../../store/uiStore";

const templateCategories = [
  { value: "INVOICE_CREATED", label: "Invoice Created" },
  { value: "DUE_TODAY", label: "Payment Due Today" },
  { value: "PAYMENT_OVERDUE", label: "Payment Overdue" },
  { value: "PAYMENT_REMINDER", label: "Payment Reminder" },
  { value: "PAYMENT_RECEIVED", label: "Payment Received" },
  { value: "CREDIT_NOTE", label: "Credit Note" },
  { value: "SALES_RETURN", label: "Sales Return" },
  { value: "QUOTATION", label: "Quotation" },
  { value: "CUSTOM", label: "Custom" },
];
const categoryLabel = (value) => templateCategories.find((item) => item.value === value)?.label || String(value || "Custom").replaceAll("_", " ");
const defaultTemplateForm = () => ({ code: "", name: "", category: "PAYMENT_OVERDUE", channel: "EMAIL", subject: "", body: "", isActive: true, isDefault: false });
const templateToForm = (template) => ({
  code: template?.code || "",
  name: template?.name || "",
  category: template?.category || "CUSTOM",
  channel: template?.channel || "EMAIL",
  subject: template?.subject || "",
  body: template?.body || "",
  isActive: template?.isActive !== false,
  isDefault: Boolean(template?.isDefault),
});
const sampleVariables = {
  customer_name: "Aarav Sharma",
  invoice_number: "INV-00042",
  invoice_amount: "₹25,000.00",
  outstanding_amount: "₹8,500.00",
  due_date: "12 Sep 2026",
  business_name: "BillStack Demo",
  business_phone: "+91 98765 43210",
  business_email: "billing@example.com",
  payment_link: "https://example.com/pay/INV-00042",
  payment_amount: "₹16,500.00",
  credit_note_number: "CN-00012",
  credit_note_amount: "₹2,500.00",
  return_amount: "₹1,250.00",
  quotation_number: "QUO-00018",
  quotation_amount: "₹32,000.00",
  valid_until: "30 Sep 2026",
};
const renderPreview = (value) => String(value || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => sampleVariables[key] || match);
const dateTime = (value) => value ? new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-";
const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const statusClass = (status) => status === "SENT" || status === "DELIVERED" || status === "READ" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : status === "FAILED" ? "bg-rose-500/10 text-rose-700 dark:text-rose-300" : status === "SKIPPED" || status === "CANCELLED" ? "bg-slate-500/10 text-slate-600 dark:text-slate-300" : "bg-brand-500/10 text-brand-700 dark:text-brand-200";
const reminderTypeLabels = {
  BEFORE_DUE_DATE: "Before due date",
  ON_DUE_DATE: "On due date",
  AFTER_DUE_DATE: "After due date",
  RECURRING_OVERDUE: "Recurring overdue",
};
const eventTypeLabels = {
  INVOICE_ISSUED: "Invoice Issued",
  PAYMENT_RECORDED: "Payment Successfully Recorded",
};
const paymentConditionLabels = {
  ANY_PAYMENT: "Any payment",
  PARTIAL_PAYMENT: "Partial payment",
  FULL_PAYMENT: "Full payment",
};
const generatedRuleName = (form) => {
  if (form.trigger === "INVOICE_ISSUED") return "Invoice Issued";
  if (form.trigger === "PAYMENT_RECORDED") return `Payment Successfully Recorded - ${paymentConditionLabels[form.condition] || "Any payment"}`;
  const days = Number(form.offsetDays || 0);
  const repeat = Number(form.repeatEveryDays || 0);
  if (form.trigger === "ON_DUE_DATE") return "On due date";
  if (form.trigger === "BEFORE_DUE_DATE") return `${days} ${days === 1 ? "day" : "days"} before due date`;
  if (form.trigger === "AFTER_DUE_DATE") return `${days} ${days === 1 ? "day" : "days"} after due date`;
  return `Every ${repeat} ${repeat === 1 ? "day" : "days"} after overdue`;
};
const defaultCategoryForTrigger = (trigger, currentCategory = "PAYMENT_REMINDER") => {
  if (trigger === "INVOICE_ISSUED") return "INVOICE_CREATED";
  if (trigger === "PAYMENT_RECORDED") return "PAYMENT_RECEIVED";
  if (trigger === "ON_DUE_DATE") return "DUE_TODAY";
  if (trigger === "AFTER_DUE_DATE" || trigger === "RECURRING_OVERDUE") return "PAYMENT_OVERDUE";
  if (trigger === "BEFORE_DUE_DATE") return "PAYMENT_REMINDER";
  return currentCategory;
};
const normalizeRuleFormForType = (current, trigger) => ({
  ...current,
  trigger,
  category: defaultCategoryForTrigger(trigger, current.category),
  isEnabled: trigger === "INVOICE_ISSUED" || trigger === "PAYMENT_RECORDED" ? false : current.isEnabled,
  offsetDays: trigger === "ON_DUE_DATE" || trigger === "RECURRING_OVERDUE" || trigger === "INVOICE_ISSUED" || trigger === "PAYMENT_RECORDED" ? 0 : current.offsetDays || 1,
  repeatEveryDays: trigger === "RECURRING_OVERDUE" ? current.repeatEveryDays || 1 : 0,
  sendTime: trigger === "INVOICE_ISSUED" || trigger === "PAYMENT_RECORDED" ? "" : current.sendTime || "10:00",
  condition: trigger === "PAYMENT_RECORDED" ? current.condition || "ANY_PAYMENT" : "ANY_PAYMENT",
  templateId: "",
});
const isEventTrigger = (trigger) => trigger === "INVOICE_ISSUED" || trigger === "PAYMENT_RECORDED";
const communicationTabs = [
  { id: "overview", label: "Overview" },
  { id: "templates", label: "Templates" },
  { id: "automation", label: "Automation" },
  { id: "delivery", label: "Delivery / History" },
  { id: "settings", label: "Settings" },
];
const ruleToForm = (rule = {}) => {
  const trigger = rule.trigger || "BEFORE_DUE_DATE";
  const channel = Array.isArray(rule.channels) ? rule.channels[0] : rule.channel;
  return {
    sourceKey: rule.sourceKey || "",
    trigger,
    offsetDays: rule.offsetDays ?? (trigger === "BEFORE_DUE_DATE" ? 3 : 0),
    repeatEveryDays: rule.repeatEveryDays ?? 0,
    channel: channel || "EMAIL",
    category: rule.category || defaultCategoryForTrigger(trigger),
    condition: rule.condition || "ANY_PAYMENT",
    templateId: typeof rule.templateId === "object" ? rule.templateId?._id || "" : rule.templateId || "",
    sendTime: rule.sendTime || (isEventTrigger(trigger) ? "" : "10:00"),
    isEnabled: rule.isEnabled !== false,
  };
};

const CommunicationsPage = () => {
  const [tab, setTab] = useState("overview");
  const [summary, setSummary] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [rules, setRules] = useState([]);
  const [scheduled, setScheduled] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ruleForm, setRuleForm] = useState({ sourceKey: "", trigger: "BEFORE_DUE_DATE", offsetDays: 3, repeatEveryDays: 0, channel: "EMAIL", category: "PAYMENT_OVERDUE", condition: "ANY_PAYMENT", templateId: "", sendTime: "10:00", isEnabled: true });
  const [templateForm, setTemplateForm] = useState(defaultTemplateForm);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [summaryData, templateData, ruleData, scheduledData, deliveryData] = await Promise.all([
        communicationSummaryRequest(),
        communicationTemplatesRequest(),
        communicationRulesRequest(),
        communicationScheduledRequest(),
        communicationDeliveriesRequest(),
      ]);
      setSummary(summaryData);
      setTemplates(templateData);
      setRules(ruleData);
      setScheduled(scheduledData);
      setDeliveries(deliveryData);
    } catch (loadError) {
      setError(loadError.response?.data?.message || "Unable to load communications.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const createRule = async (event) => {
    event.preventDefault();
    try {
      await createCommunicationRuleRequest({ ...ruleForm, name: generatedRuleName(ruleForm) });
      uiStore.getState().pushToast({ tone: "success", message: "Automation rule saved." });
      await load();
    } catch (saveError) {
      setError(saveError.response?.data?.message || "Unable to save reminder rule.");
    }
  };

  const saveTemplate = async (event) => {
    event.preventDefault();
    try {
      await upsertCommunicationTemplateRequest(templateForm);
      uiStore.getState().pushToast({ tone: "success", message: "Communication template saved." });
      setTemplateForm(defaultTemplateForm());
      await load();
    } catch (saveError) {
      setError(saveError.response?.data?.message || "Unable to save template.");
    }
  };

  if (loading) return <LoadingState title="Loading communications" description="Fetching reminder rules, templates, and delivery logs." />;

  const metrics = [
    ["Messages sent", summary?.messagesSent || 0, Send],
    ["Scheduled reminders", summary?.scheduledReminders || 0, CalendarClock],
    ["Failed messages", summary?.failedMessages || 0, CircleAlert],
    ["Delivered/read", summary?.deliveredMessages || 0, CheckCircle2],
  ];

  return <div className="mx-auto max-w-[1500px] space-y-6 pb-8">
    <PageHeader
      kicker="Communications"
      title="WhatsApp, email and payment reminders"
      description="Automated invoice reminders. WhatsApp stays disabled until the WhatsApp Business API is configured."
      actions={<button type="button" onClick={load} className="btn-secondary"><RefreshCw size={16} /> Refresh</button>}
    />
    {error ? <div role="alert" className="alert alert-error"><CircleAlert size={18} /><span>{error}</span></div> : null}
    <section className="stat-grid">{metrics.map(([label, value, Icon]) => <div key={label} className="panel stat-card"><div className="flex items-center justify-between"><p className="stat-label">{label}</p><Icon size={15} style={{ color: "var(--text-muted)" }} /></div><p className="stat-value">{value}</p></div>)}</section>
    <nav aria-label="Communication sections" className="segmented no-scrollbar">{communicationTabs.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)} className={`segmented-item ${tab === item.id ? "is-active" : ""}`}>{item.label}</button>)}</nav>
    {tab === "overview" ? <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.8fr)]"><ReminderTable title="Upcoming reminders" rows={summary?.upcoming || []} /><ProviderSettings status={summary?.providerStatus} /></section> : null}
    {tab === "automation" ? <AutomationPanel scheduled={scheduled} rules={rules} form={ruleForm} setForm={setRuleForm} templates={templates} providerStatus={summary?.providerStatus} onSubmit={createRule} /> : null}
    {tab === "templates" ? <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]"><TemplateGrid templates={templates} onEdit={(template) => setTemplateForm(templateToForm(template))} onDuplicate={(template) => setTemplateForm({ ...templateToForm(template), code: "", name: `${template.name} Copy`, isDefault: false })} onQuickSave={async (template, patch) => { await upsertCommunicationTemplateRequest({ ...templateToForm(template), ...patch }); await load(); }} /><TemplateForm form={templateForm} setForm={setTemplateForm} providerStatus={summary?.providerStatus} onSubmit={saveTemplate} onCancel={() => setTemplateForm(defaultTemplateForm())} /></section> : null}
    {tab === "delivery" ? <DeliveryTable rows={deliveries} /> : null}
    {tab === "settings" ? <ProviderSettings status={summary?.providerStatus} /> : null}
  </div>;
};

const ReminderTable = ({ rows, title = "Payment reminders" }) => (
  <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <h3 className="text-lg font-semibold">{title}</h3>
    <div className="mt-4 overflow-x-auto rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>
      <table className="min-w-[780px] w-full text-left text-sm">
        <thead className="bg-slate-500/5 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          <tr><th className="p-3">Customer</th><th className="p-3">Invoice</th><th className="p-3 text-right">Outstanding</th><th className="p-3">Due date</th><th className="p-3">Next reminder</th><th className="p-3">Channel</th><th className="p-3">Status</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row._id} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
              <td className="p-3 font-medium">{row.customerId?.name || "Customer"}</td>
              <td className="p-3">{row.invoiceId?.invoiceNumber || "-"}</td>
              <td className="p-3 text-right">{money(row.outstandingAmountSnapshot || row.invoiceId?.balanceDue)}</td>
              <td className="p-3">{dateTime(row.invoiceId?.dueDate)}</td>
              <td className="p-3">{dateTime(row.scheduledFor)}</td>
              <td className="p-3">{row.channel}</td>
              <td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(row.status)}`}>{row.status}</span></td>
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan="7" className="p-8"><EmptyState title="No reminders scheduled" description="Schedule reminders from invoice detail or create automation rules." /></td></tr> : null}
        </tbody>
      </table>
    </div>
  </section>
);

const DeliveryTable = ({ rows }) => (
  <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <h3 className="text-lg font-semibold">Delivery logs</h3>
    <div className="mt-4 overflow-x-auto rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>
      <table className="min-w-[760px] w-full text-left text-sm">
        <thead className="bg-slate-500/5 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          <tr><th className="p-3">Channel</th><th className="p-3">Recipient</th><th className="p-3">Invoice</th><th className="p-3">Status</th><th className="p-3">Failure</th><th className="p-3">Created</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row._id} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
              <td className="p-3">{row.channel}</td>
              <td className="p-3">{row.recipient || "-"}</td>
              <td className="p-3">{row.invoiceId?.invoiceNumber || "-"}</td>
              <td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(row.status)}`}>{row.status}</span></td>
              <td className="p-3" style={{ color: "var(--text-muted)" }}>{row.failureReason || "-"}</td>
              <td className="p-3">{dateTime(row.createdAt)}</td>
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan="6" className="p-8"><EmptyState title="No delivery history" description="Messages and reminders will appear here after they are attempted." /></td></tr> : null}
        </tbody>
      </table>
    </div>
  </section>
);

const AutomationPanel = ({ scheduled, rules, form, setForm, templates, providerStatus, onSubmit }) => {
  const chooseTrigger = (trigger) => setForm((value) => ({ ...normalizeRuleFormForType(value, trigger), sourceKey: "" }));
  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-6">
        <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-lg font-semibold">Automation</h3>
              <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Configure scheduled reminders and event-based communication rules. Rules are visible even before any reminder has been generated.</p>
            </div>
            <span className="rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-700 dark:text-brand-200">{rules.length} rules</span>
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <AutomationTriggerGroup title="Scheduled" description="Use invoice due dates to schedule payment reminders." items={reminderTypeLabels} activeTrigger={form.trigger} onChoose={chooseTrigger} />
            <AutomationTriggerGroup title="Event Based" description="Send only after the authoritative BillStack event succeeds." items={eventTypeLabels} activeTrigger={form.trigger} onChoose={chooseTrigger} />
          </div>
        </section>
        <RulesList rows={rules} onEdit={(rule) => setForm(ruleToForm(rule))} />
        <ReminderTable title="Scheduled reminder queue" rows={scheduled} />
      </div>
      <RuleForm form={form} setForm={setForm} templates={templates} providerStatus={providerStatus} onSubmit={onSubmit} />
    </section>
  );
};

const AutomationTriggerGroup = ({ title, description, items, activeTrigger, onChoose }) => (
  <div className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)" }}>
    <h4 className="font-semibold">{title}</h4>
    <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{description}</p>
    <div className="mt-4 grid gap-2">
      {Object.entries(items).map(([trigger, label]) => (
        <button
          key={trigger}
          type="button"
          onClick={() => onChoose(trigger)}
          className={`rounded-lg border px-3 py-2 text-left text-sm font-medium ${activeTrigger === trigger ? "bg-brand-600 text-white" : ""}`}
          style={activeTrigger === trigger ? {} : { borderColor: "var(--panel-border)", color: "var(--text-muted)" }}
        >
          {label}
        </button>
      ))}
    </div>
  </div>
);

const RulesList = ({ rows, onEdit }) => (
  <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <h3 className="text-lg font-semibold">Configured automation rules</h3>
    <div className="mt-4 overflow-x-auto rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>
      <table className="min-w-[760px] w-full text-left text-sm">
        <thead className="bg-slate-500/5 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          <tr><th className="p-3">Rule</th><th className="p-3">Type</th><th className="p-3">Channel</th><th className="p-3">Template</th><th className="p-3">Status</th><th className="p-3 text-right">Action</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const triggerLabel = eventTypeLabels[row.trigger] || reminderTypeLabels[row.trigger] || row.trigger;
            return (
              <tr key={row._id} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
                <td className="p-3 font-medium">{row.name || triggerLabel}</td>
                <td className="p-3">{triggerLabel}</td>
                <td className="p-3">{Array.isArray(row.channels) ? row.channels.join(", ") : row.channel || "-"}</td>
                <td className="p-3">{row.templateId?.name || "Default template"}</td>
                <td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${row.isEnabled === false ? "bg-slate-500/10 text-slate-500" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{row.isEnabled === false ? "Inactive" : "Active"}</span></td>
                <td className="p-3 text-right"><button type="button" onClick={() => onEdit(row)} className="rounded-lg border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--panel-border)" }}>Edit</button></td>
              </tr>
            );
          })}
          {!rows.length ? <tr><td colSpan="6" className="p-8"><EmptyState title="No automation rules yet" description="Choose a scheduled or event-based trigger, then save a rule." /></td></tr> : null}
        </tbody>
      </table>
    </div>
  </section>
);

const TemplateGrid = ({ templates, onEdit, onDuplicate, onQuickSave }) => (
  <section className="grid gap-4 md:grid-cols-2">
    {templates.map((template) => (
      <article key={template._id} className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => onEdit(template)} className="text-left font-semibold hover:text-brand-600">{template.name}</button>
          <div className="flex flex-wrap justify-end gap-2">
            {template.isDefault ? <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300">Default</span> : null}
            <span className="rounded-full bg-brand-500/10 px-2 py-1 text-xs text-brand-700 dark:text-brand-200">{template.channel}</span>
            <span className={`rounded-full px-2 py-1 text-xs ${template.isActive === false ? "bg-slate-500/10 text-slate-500" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{template.isActive === false ? "Inactive" : "Active"}</span>
          </div>
        </div>
        {template.subject ? <p className="mt-3 text-sm font-medium">{template.subject}</p> : null}
        <p className="mt-3 text-sm" style={{ color: "var(--text-muted)" }}>{template.body}</p>
        <p className="mt-4 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{categoryLabel(template.category)}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => onEdit(template)} className="rounded-lg border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--panel-border)" }}>Edit</button>
          <button type="button" onClick={() => onDuplicate(template)} className="rounded-lg border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--panel-border)" }}>Duplicate</button>
          <button type="button" onClick={() => onQuickSave(template, { isActive: template.isActive === false, isDefault: template.isDefault && template.isActive === false ? true : template.isDefault })} className="rounded-lg border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--panel-border)" }}>{template.isActive === false ? "Activate" : "Deactivate"}</button>
          {!template.isDefault ? <button type="button" onClick={() => onQuickSave(template, { isDefault: true, isActive: true })} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white">Set default</button> : null}
        </div>
      </article>
    ))}
  </section>
);

const TemplateForm = ({ form, setForm, providerStatus, onSubmit, onCancel }) => {
  const channels = channelOptions(providerStatus);
  return <form onSubmit={onSubmit} className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <h3 className="text-lg font-semibold">Template management</h3>
    <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Create, edit, duplicate and preview templates. Delivery still uses the selected/default active template from the backend.</p>
    <div className="mt-4 grid gap-4">
      <Field label="Template name"><input required value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} className="field" /></Field>
      <Field label="Category"><select value={form.category} onChange={(event) => setForm((value) => ({ ...value, category: event.target.value }))} className="field">{templateCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
      <Field label="Channel"><select value={form.channel} onChange={(event) => setForm((value) => ({ ...value, channel: event.target.value }))} className="field">{channels.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></Field>
      {form.channel === "EMAIL" ? <Field label="Subject"><input value={form.subject} onChange={(event) => setForm((value) => ({ ...value, subject: event.target.value }))} className="field" /></Field> : null}
      <Field label="Body"><textarea required rows="6" value={form.body} onChange={(event) => setForm((value) => ({ ...value, body: event.target.value }))} className="field" /></Field>
      <div className="grid gap-3 rounded-xl border p-3 text-sm" style={{ borderColor: "var(--panel-border)" }}>
        <label className="flex items-center gap-3"><input type="checkbox" checked={form.isActive !== false} onChange={(event) => setForm((value) => ({ ...value, isActive: event.target.checked }))} /> Active</label>
        <label className="flex items-center gap-3"><input type="checkbox" checked={Boolean(form.isDefault)} onChange={(event) => setForm((value) => ({ ...value, isDefault: event.target.checked, isActive: event.target.checked ? true : value.isActive }))} /> Set as default for {categoryLabel(form.category)} / {form.channel}</label>
      </div>
      <div className="rounded-xl border p-3" style={{ borderColor: "var(--panel-border)" }}>
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Preview only</p>
        {form.subject && form.channel === "EMAIL" ? <p className="mt-2 text-sm font-semibold">{renderPreview(form.subject)}</p> : null}
        <p className="mt-2 whitespace-pre-line text-sm" style={{ color: "var(--text-muted)" }}>{renderPreview(form.body) || "Write a template body to preview sample values."}</p>
      </div>
    </div>
    <div className="mt-5 flex flex-wrap gap-2">
      <button className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white"><Mail size={16} /> Save template</button>
      <button type="button" onClick={onCancel} className="rounded-xl border px-4 py-3 text-sm font-semibold" style={{ borderColor: "var(--panel-border)" }}>New blank template</button>
    </div>
  </form>;
};

const RuleForm = ({ form, setForm, templates, providerStatus, onSubmit }) => {
  const channels = channelOptions(providerStatus);
  const ruleName = generatedRuleName(form);
  const isEventRule = form.trigger === "INVOICE_ISSUED" || form.trigger === "PAYMENT_RECORDED";
  const matchingTemplates = templates.filter((template) => template.isActive !== false && template.channel === form.channel && template.category === form.category);
  return (
  <form onSubmit={onSubmit} className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <h3 className="text-lg font-semibold">Automation rule</h3>
    <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Scheduled reminders use due dates. Event-based rules run only after the authoritative invoice/payment event succeeds.</p>
    <div className="mt-4 grid gap-4">
      <div className="rounded-xl border px-4 py-3" style={{ borderColor: "var(--panel-border)" }}>
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Generated rule name</p>
        <p className="mt-1 font-semibold">{ruleName}</p>
      </div>
      <Field label="Trigger"><select value={form.trigger} onChange={(event) => setForm((value) => ({ ...normalizeRuleFormForType(value, event.target.value), sourceKey: "" }))} className="field"><optgroup label="Scheduled">{Object.entries(reminderTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup><optgroup label="Event Based">{Object.entries(eventTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup></select></Field>
      {form.trigger === "PAYMENT_RECORDED" ? <Field label="Condition"><select value={form.condition || "ANY_PAYMENT"} onChange={(event) => setForm((value) => ({ ...value, condition: event.target.value, templateId: "" }))} className="field">{Object.entries(paymentConditionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field> : null}
      <Field label="Template category"><select value={form.category} disabled={isEventRule} onChange={(event) => setForm((value) => ({ ...value, category: event.target.value, templateId: "" }))} className="field">{templateCategories.filter((item) => isEventRule ? ["INVOICE_CREATED", "PAYMENT_RECEIVED"].includes(item.value) : ["DUE_TODAY", "PAYMENT_OVERDUE", "PAYMENT_REMINDER", "CUSTOM"].includes(item.value)).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
      {form.trigger === "BEFORE_DUE_DATE" ? <Field label="Days before due date"><input required type="number" min="1" step="1" value={form.offsetDays} onChange={(event) => setForm((value) => ({ ...value, offsetDays: event.target.value }))} className="field" /></Field> : null}
      {form.trigger === "AFTER_DUE_DATE" ? <Field label="Days after due date"><input required type="number" min="1" step="1" value={form.offsetDays} onChange={(event) => setForm((value) => ({ ...value, offsetDays: event.target.value }))} className="field" /></Field> : null}
      {form.trigger === "RECURRING_OVERDUE" ? <Field label="Repeat every X days"><input required type="number" min="1" step="1" value={form.repeatEveryDays} onChange={(event) => setForm((value) => ({ ...value, repeatEveryDays: event.target.value }))} className="field" /></Field> : null}
      <Field label="Channel"><select value={form.channel} onChange={(event) => setForm((value) => ({ ...value, channel: event.target.value, templateId: "" }))} className="field">{channels.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></Field>
      <Field label="Template"><select value={form.templateId || ""} onChange={(event) => setForm((value) => ({ ...value, templateId: event.target.value }))} className="field"><option value="">Use default template</option>{matchingTemplates.map((template) => <option key={template._id} value={template._id}>{template.name}{template.isDefault ? " (default)" : ""}</option>)}</select></Field>
      {!isEventRule ? <Field label="Send time"><input required type="time" value={form.sendTime} onChange={(event) => setForm((value) => ({ ...value, sendTime: event.target.value }))} className="field" /></Field> : null}
      <label className="flex items-center gap-3 rounded-xl border p-3" style={{ borderColor: "var(--panel-border)" }}><input type="checkbox" checked={form.isEnabled === true} onChange={(event) => setForm((value) => ({ ...value, isEnabled: event.target.checked }))} /> <span className="text-sm font-medium">Active{isEventRule ? " (off by default)" : ""}</span></label>
    </div>
    <button className="mt-5 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white"><BellRing size={16} /> Save rule</button>
  </form>
  );
};

const channelOptions = (status) => [
  { value: "EMAIL", label: status?.email?.configured === false ? "Email (SMTP not configured)" : "Email", disabled: status?.email?.configured === false },
  { value: "WHATSAPP", label: status?.whatsapp?.configured ? "WhatsApp" : "WhatsApp (not configured)", disabled: !status?.whatsapp?.configured },
  { value: "SMS", label: status?.sms?.configured ? "SMS" : "SMS (not configured)", disabled: !status?.sms?.configured },
  { value: "IN_APP", label: "In-app", disabled: false },
];

const ProviderSettings = ({ status }) => (
  <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <div className="flex items-center gap-2"><Settings size={18} className="text-brand-600" /><h3 className="text-lg font-semibold">Channel settings</h3></div>
    <div className="mt-4 space-y-3">
      <ProviderRow icon={MessageCircle} label="WhatsApp Business API" configured={status?.whatsapp?.configured} note={status?.whatsapp?.configured ? "Configured through environment" : "Not configured. Native BillStack WhatsApp flow is disabled."} />
      <ProviderRow icon={Mail} label="Email" configured={status?.email?.configured} note={status?.email?.configured ? "SMTP configured" : "SMTP not configured"} />
      <ProviderRow icon={Smartphone} label="SMS" configured={status?.sms?.configured} note="Provider-ready only. No SMS provider configured." />
    </div>
  </section>
);

const ProviderRow = ({ icon: Icon, label, configured, note }) => (
  <div className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)" }}>
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 font-medium"><Icon size={17} /> {label}</span>
      <span className={`rounded-full px-2 py-1 text-xs ${configured ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-200"}`}>{configured ? "Connected" : "Not configured"}</span>
    </div>
    <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>{note}</p>
  </div>
);

const Field = ({ label, children }) => <label><span className="mb-2 block text-sm font-medium">{label}</span>{children}</label>;

export default CommunicationsPage;
