import { useEffect, useState } from "react";
import { Check, Copy, ShieldCheck, ShieldOff } from "lucide-react";
import PageHeader from "../../../components/ui/PageHeader";
import { ErrorState, LoadingState } from "../../../components/ui/PageState";
import { authStore } from "../../../store/authStore";
import { uiStore } from "../../../store/uiStore";
import {
  twoFactorDisableRequest,
  twoFactorEnableRequest,
  twoFactorSetupRequest,
  twoFactorStatusRequest,
} from "../../auth/api";

// Two-step sign-in for the signed-in user: an authenticator app (Google Authenticator, Microsoft
// Authenticator, Authy...) gives a 6-digit code that is asked for after the password.

const CopyText = ({ text, label = "Copy" }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn-secondary" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }}>
      {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : label}
    </button>
  );
};

const SecurityPage = () => {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [setup, setSetup] = useState(null); // { secret, otpauthUrl }
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [code, setCode] = useState("");
  const [turningOff, setTurningOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoadError("");
    try {
      setState(await twoFactorStatusRequest());
    } catch (err) {
      setLoadError(err.response?.data?.message || "Unable to load your sign-in settings.");
    }
  };

  useEffect(() => { load(); }, []);

  const markUser = (enabled) => {
    const { user } = authStore.getState();
    if (user) authStore.setState({ user: { ...user, twoFactorEnabled: enabled } });
  };

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err.response?.data?.message || "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => { setSetup(await twoFactorSetupRequest()); setCode(""); });
  const confirm = (event) => {
    event.preventDefault();
    run(async () => {
      const result = await twoFactorEnableRequest(code.trim());
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode("");
      markUser(true);
      await load();
    });
  };
  const switchOff = (event) => {
    event.preventDefault();
    run(async () => {
      await twoFactorDisableRequest(code.trim());
      setTurningOff(false);
      setCode("");
      markUser(false);
      uiStore.getState().pushToast({ tone: "info", message: "Two-step sign-in is off. Your password alone signs you in now." });
      await load();
    });
  };

  if (loadError) return <ErrorState title="Unable to load security settings" description={loadError} />;
  if (!state) return <LoadingState title="Loading" description="Checking your sign-in settings." />;

  const secretGroups = setup?.secret?.replace(/(.{4})/g, "$1 ").trim();

  return (
    <div className="mx-auto max-w-[900px] space-y-5 pb-8">
      <PageHeader kicker="Your account" title="Sign-in security" description="Add a second step to signing in, so a stolen password alone can't open BillStack." />

      {recoveryCodes ? (
        <section className="panel space-y-3 p-5">
          <h2 className="text-base font-semibold">Save your recovery codes now</h2>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>If you lose your phone, each of these codes signs you in once instead of the app. They won't be shown again. Keep them somewhere safe and offline (printed, or in a password manager).</p>
          <ol className="grid grid-cols-2 gap-2 rounded-xl border p-4 font-mono text-sm sm:grid-cols-5" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}>
            {recoveryCodes.map((item) => <li key={item}>{item}</li>)}
          </ol>
          <div className="flex justify-end gap-2">
            <CopyText text={recoveryCodes.join("\n")} label="Copy all" />
            <button type="button" className="btn-primary" onClick={() => setRecoveryCodes(null)}>I've saved them</button>
          </div>
        </section>
      ) : null}

      <section className="panel space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {state.enabled ? <ShieldCheck size={22} className="text-emerald-600" /> : <ShieldOff size={22} style={{ color: "var(--text-muted)" }} />}
            <div>
              <h2 className="text-base font-semibold">Two-step sign-in {state.enabled ? "is on" : "is off"}</h2>
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                {state.enabled
                  ? `On since ${state.enabledAt ? new Date(state.enabledAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "-"} · ${state.recoveryLeft} recovery code${state.recoveryLeft === 1 ? "" : "s"} left`
                  : "After your password (or Google), BillStack will ask for a 6-digit code from an authenticator app on your phone."}
              </p>
            </div>
          </div>
          {!state.enabled && !setup ? <button type="button" className="btn-primary" disabled={busy || !state.canStoreSecrets} onClick={start}>Switch on</button> : null}
          {state.enabled && !turningOff ? <button type="button" className="btn-secondary" onClick={() => { setTurningOff(true); setCode(""); setError(""); }}>Switch off</button> : null}
        </div>

        {!state.enabled && !state.canStoreSecrets ? <p className="alert alert-error">The server isn't set up to store the app's secret yet (BILLSTACK_DATA_KEY). Ask whoever runs your server.</p> : null}

        {setup ? (
          <form onSubmit={confirm} className="space-y-4 rounded-xl border p-4" style={{ borderColor: "var(--panel-border)" }}>
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li>Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator or Authy).</li>
              <li>
                In the app choose <b>Add account → Enter a setup key</b>. Account: your email. Key:
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded-lg border px-3 py-2 font-mono text-base tracking-wider" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}>{secretGroups}</code>
                  <CopyText text={setup.secret} />
                </div>
                <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Type: time-based. On the phone itself you can instead <a href={setup.otpauthUrl} className="font-medium text-brand-700 underline dark:text-brand-300">open this link</a> to add it.</p>
              </li>
              <li>Type the 6-digit code the app shows:</li>
            </ol>
            <div className="flex flex-wrap items-end gap-2">
              <label className="form-field">
                <span className="form-label">Code from the app</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="field w-40 font-mono" autoFocus />
              </label>
              <button type="submit" className="btn-primary" disabled={busy || code.trim().length < 6}>{busy ? "Checking…" : "Switch on"}</button>
              <button type="button" className="btn-secondary" onClick={() => { setSetup(null); setError(""); }}>Cancel</button>
            </div>
          </form>
        ) : null}

        {turningOff ? (
          <form onSubmit={switchOff} className="space-y-3 rounded-xl border p-4" style={{ borderColor: "var(--panel-border)" }}>
            <p className="text-sm">To switch it off, type a current code from the app (or a recovery code).</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="form-field">
                <span className="form-label">Code</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" className="field w-48 font-mono" autoFocus />
              </label>
              <button type="submit" className="btn-danger" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Switch off"}</button>
              <button type="button" className="btn-secondary" onClick={() => { setTurningOff(false); setError(""); }}>Cancel</button>
            </div>
          </form>
        ) : null}

        {error ? <p role="alert" className="alert alert-error">{error}</p> : null}
      </section>

      <section className="panel p-5 text-sm" style={{ color: "var(--text-muted)" }}>
        <h2 className="mb-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Good to know</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Each code works once and changes every 30 seconds. If codes are refused, set the phone's time to automatic.</li>
          <li>Five wrong codes pause the second step for 15 minutes.</li>
          <li>Moving to a new phone: switch it off here (with a code from the old phone) and switch it on again.</li>
          <li>Lost the phone and the recovery codes? An owner or admin can reset your two-step sign-in from the Team page.</li>
        </ul>
      </section>
    </div>
  );
};

export default SecurityPage;
