import { useEffect, useMemo, useRef, useState } from "react";
import BillingEntitySettings from "../../workspace/BillingEntitySettings";
import gstStates from "../../../../../shared/indian-gst-states.json";
import {
  communicationSummaryRequest,
  acceptModuleOfferRequest,
  createModuleRequestRequest,
  createModuleRazorpayOrderRequest,
  createIntegrationCredentialRequest,
  declineModuleOfferRequest,
  getBusinessModulesRequest,
  listIntegrationCredentialsRequest,
  listIntegrationEventsRequest,
  revokeIntegrationCredentialRequest,
  submitModuleManualUpiRequest,
  updateBusinessModuleStateRequest,
  updateBusinessSetupRequest,
  verifyModuleRazorpayPaymentRequest,
} from "../../auth/api";
import { authStore } from "../../../store/authStore";
import { isRealEstateSelfHostedWorkspace, shouldShowCommercialSettings, settingsVisibility } from "../../workspace/workspaceVisibility";

const getApiOrigin = () => {
  const apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api";
  return apiBase.replace(/\/api$/, "");
};

const loadRazorpayCheckout = () =>
  new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("Checkout is unavailable"));
    if (window.Razorpay) return resolve(window.Razorpay);

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => reject(new Error("Unable to load Razorpay Checkout"));
    document.body.appendChild(script);
  });

const BusinessSettingsPage = () => {
  const { business, updateBusiness, user } = authStore();
  const [form, setForm] = useState({
    name: business?.name || "",
    email: business?.email || "",
    billingEmail: business?.billingEmail || "",
    phone: business?.phone || "",
    address: business?.address || "",
    gstTaxId: business?.gstTaxId || "",
    gstEnabled: business?.gstConfiguration?.enabled || false,
    gstConfigurationGstin: business?.gstConfiguration?.gstin || business?.gstTaxId || "",
    gstStateCode: gstStates[(business?.gstConfiguration?.gstin || business?.gstTaxId || "").slice(0, 2)] ? (business?.gstConfiguration?.gstin || business?.gstTaxId || "").slice(0, 2) : business?.gstConfiguration?.stateCode || "",
    gstState: gstStates[(business?.gstConfiguration?.gstin || business?.gstTaxId || "").slice(0, 2)] || business?.gstConfiguration?.state || "",
    invoiceTerms: business?.invoiceTerms || "",
    taxName: business?.defaultTaxSettings?.taxName || "GST",
    taxRate: business?.defaultTaxSettings?.taxRate ?? 18,
    taxMode: business?.defaultTaxSettings?.taxMode || "exclusive",
    invoicePrefix: business?.invoiceNumbering?.prefix || "INV",
    invoiceNumberingFormat: business?.invoiceNumbering?.format || "INV-{YYYY}-{0001}",
    bankAccountName: business?.bankDetails?.accountName || "",
    bankName: business?.bankDetails?.bankName || "",
    bankAccountNumber: business?.bankDetails?.accountNumber || "",
    bankIfscCode: business?.bankDetails?.ifscCode || "",
    bankUpiId: business?.bankDetails?.upiId || "",
    industry: business?.industry || "",
    allowNegativeStock: business?.inventorySettings?.allowNegativeStock || false,
  });
  const [logoFile, setLogoFile] = useState(null);
  const [signatureFile, setSignatureFile] = useState(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [removeSignature, setRemoveSignature] = useState(false);
  const [section, setSection] = useState("Business Profile");
  const [saved, setSaved] = useState(false);
  const saveLock = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [communicationSummary, setCommunicationSummary] = useState(null);
  const [integrationCredentials, setIntegrationCredentials] = useState([]);
  const [integrationEvents, setIntegrationEvents] = useState([]);
  const [newIntegrationKey, setNewIntegrationKey] = useState("");
  const [integrationError, setIntegrationError] = useState("");
  const [pendingRevokeCredential, setPendingRevokeCredential] = useState(null);
  const [moduleData, setModuleData] = useState(null);
  const [moduleMessage, setModuleMessage] = useState("");
  const [moduleError, setModuleError] = useState("");
  const [manualUpiOfferId, setManualUpiOfferId] = useState("");
  const [manualUpiReference, setManualUpiReference] = useState("");
  const isRealEstateSelfHosted = isRealEstateSelfHostedWorkspace(moduleData, business);
  const visibility = settingsVisibility(moduleData, business);

  const logoPreviewUrl = useMemo(() => {
    if (logoFile) return URL.createObjectURL(logoFile);
    if (!removeLogo && business?.logoUrl) return `${getApiOrigin()}${business.logoUrl}`;
    return "";
  }, [business?.logoUrl, logoFile, removeLogo]);
  useEffect(() => () => { if (logoFile && logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl); }, [logoFile, logoPreviewUrl]);
  const signaturePreviewUrl = useMemo(() => {
    if (signatureFile) return URL.createObjectURL(signatureFile);
    if (!removeSignature && business?.signatureUrl) return `${getApiOrigin()}${business.signatureUrl}`;
    return "";
  }, [business?.signatureUrl, signatureFile, removeSignature]);
  useEffect(() => () => { if (signatureFile && signaturePreviewUrl) URL.revokeObjectURL(signaturePreviewUrl); }, [signatureFile, signaturePreviewUrl]);

  const refreshIntegrationData = async () => {
    try {
      const [credentials, events] = await Promise.all([
        listIntegrationCredentialsRequest(),
        listIntegrationEventsRequest({ limit: 5 }),
      ]);
      setIntegrationCredentials(credentials);
      setIntegrationEvents(events);
    } catch (_error) {
      setIntegrationCredentials([]);
      setIntegrationEvents([]);
    }
  };

  useEffect(() => {
    communicationSummaryRequest()
      .then(setCommunicationSummary)
      .catch(() => setCommunicationSummary(null));
    if (visibility.integrations) refreshIntegrationData();
    refreshModules();
  }, []);

  const refreshModules = async () => {
    try {
      const data = await getBusinessModulesRequest();
      setModuleData(data);
    } catch (_error) {
      setModuleData(null);
    }
  };

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target;
    setSaved(false);
    setForm((current) => {
      const next = { ...current, [name]: type === "checkbox" ? checked : value };
      if (name === "gstConfigurationGstin") {
        next.gstConfigurationGstin = value.trim().toUpperCase();
        if (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(next.gstConfigurationGstin) && gstStates[next.gstConfigurationGstin.slice(0, 2)]) {
          next.gstStateCode = next.gstConfigurationGstin.slice(0, 2); next.gstState = gstStates[next.gstStateCode];
        }
      }
      if (name === "gstStateCode") next.gstState = gstStates[value] || "";
      return next;
    });
  };

  const handleProfileSubmit = async (event) => {
    event.preventDefault();
    if (saveLock.current) return;
    const errors = {};
    if (section !== "Branding") {
      for (const name of ["email", "billingEmail"]) if (form[name] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form[name].trim())) errors[name] = "Enter a valid email address";
      if (form.bankIfscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(form.bankIfscCode.trim().toUpperCase())) errors.bankIfscCode = "Enter a valid 11-character IFSC";
      if (form.bankUpiId && !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(form.bankUpiId.trim())) errors.bankUpiId = "Enter a valid UPI ID";
      if (form.gstEnabled && (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(form.gstConfigurationGstin) || !gstStates[form.gstStateCode])) errors.gstConfigurationGstin = "Enter a valid GSTIN and state";
      if (form.gstEnabled && form.gstConfigurationGstin.slice(0, 2) !== form.gstStateCode) errors.gstStateCode = `GSTIN belongs to ${gstStates[form.gstConfigurationGstin.slice(0, 2)]} (${form.gstConfigurationGstin.slice(0, 2)}), but the selected business state is ${form.gstState} (${form.gstStateCode}). Please correct the GST details.`;
    }
    if (Object.keys(errors).length) { setFieldErrors(errors); setSaveError(Object.values(errors)[0]); return; }
    saveLock.current = true;
    setIsSaving(true);
    setSaveError("");
    setFieldErrors({});

    try {
      const payload = new FormData();
      if (section === "Branding") {
        payload.append("updateScope", "branding");
      } else {
        Object.entries({ ...form, email: form.email.trim().toLowerCase(), billingEmail: form.billingEmail.trim().toLowerCase(), taxMode: "exclusive" }).forEach(([key, value]) => payload.append(key, value ?? ""));
      }

      if (logoFile) payload.append("logo", logoFile);
      if (signatureFile) payload.append("signature", signatureFile);
      payload.append("removeLogo", removeLogo);
      payload.append("removeSignature", removeSignature);

      const data = await updateBusinessSetupRequest(payload);
      updateBusiness(data);
      setLogoFile(null);
      setSignatureFile(null);
      setRemoveLogo(false);
      setRemoveSignature(false);
      setSaved(true);
    } catch (error) {
      setFieldErrors(error.response?.data?.errors || {});
      setSaveError(error.response?.data?.message || "Unable to update business profile");
    } finally {
      setIsSaving(false);
      saveLock.current = false;
    }
  };

  const handleCreateIntegrationKey = async () => {
    setIntegrationError("");
    setNewIntegrationKey("");
    try {
      const result = await createIntegrationCredentialRequest({
        name: "Website / CRM integration",
        source: "API",
      });
      setNewIntegrationKey(result.apiKey);
      await refreshIntegrationData();
    } catch (error) {
      setIntegrationError(error.response?.data?.message || "Unable to create integration key");
    }
  };

  const handleRevokeIntegrationKey = async (credentialId) => {
    setIntegrationError("");
    try {
      await revokeIntegrationCredentialRequest(credentialId);
      setPendingRevokeCredential(null);
      await refreshIntegrationData();
    } catch (error) {
      setIntegrationError(error.response?.data?.message || "Unable to revoke integration key");
    }
  };

  const handleModuleState = async (moduleKey, state) => {
    setModuleError("");
    setModuleMessage("");
    try {
      await updateBusinessModuleStateRequest(moduleKey, state);
      setModuleMessage("Module settings updated.");
      await refreshModules();
    } catch (error) {
      setModuleError(error.response?.data?.message || "Unable to update module");
    }
  };

  const handleModuleRequest = async (moduleKey) => {
    setModuleError("");
    setModuleMessage("");
    try {
      await createModuleRequestRequest({
        moduleKey,
        requestType: "MODULE",
        message: `Please review access for ${moduleKey}.`,
      });
      setModuleMessage("Module request submitted for review.");
    } catch (error) {
      setModuleError(error.response?.data?.message || "Unable to request module");
    }
  };

  const handleAcceptOffer = async (offerId) => {
    setModuleError("");
    setModuleMessage("");
    try {
      await acceptModuleOfferRequest(offerId);
      setModuleMessage("Offer accepted. Complete payment if required to activate the module.");
      await refreshModules();
    } catch (error) {
      setModuleError(error.response?.data?.message || "Unable to accept offer");
    }
  };

  const handleDeclineOffer = async (offerId) => {
    setModuleError("");
    setModuleMessage("");
    try {
      await declineModuleOfferRequest(offerId);
      setModuleMessage("Offer declined.");
      await refreshModules();
    } catch (error) {
      setModuleError(error.response?.data?.message || "Unable to decline offer");
    }
  };

  const handleRazorpayAddon = async (offerId) => {
    setModuleError("");
    setModuleMessage("");
    try {
      const checkout = await createModuleRazorpayOrderRequest(offerId);
      if (!checkout.razorpayKeyId) {
        setModuleMessage("Razorpay order could not be opened because provider credentials are not configured.");
        await refreshModules();
        return;
      }

      const Razorpay = await loadRazorpayCheckout();
      const razorpay = new Razorpay({
        key: checkout.razorpayKeyId,
        order_id: checkout.razorpayOrderId,
        amount: Math.round(Number(checkout.amount || 0) * 100),
        currency: checkout.currency || "INR",
        name: "BillStack",
        description: "Module add-on payment",
        handler: async (response) => {
          try {
            await verifyModuleRazorpayPaymentRequest(response);
            setModuleMessage("Payment verified. Module activation is being applied.");
            await refreshModules();
          } catch (error) {
            setModuleError(error.response?.data?.message || "Payment could not be verified");
          }
        },
        modal: {
          ondismiss: async () => {
            setModuleMessage("Razorpay checkout was closed before payment completion.");
            await refreshModules();
          },
        },
        prefill: {
          name: user?.name || "",
          email: user?.email || business?.email || "",
          contact: business?.phone || "",
        },
        notes: {
          orderId: checkout.orderId,
        },
        theme: { color: "#2563eb" },
      });
      razorpay.open();
    } catch (error) {
      setModuleError(error.response?.data?.message || "Unable to create Razorpay order");
    }
  };

  const openManualUpi = (offerId) => {
    setManualUpiOfferId(offerId);
    setManualUpiReference("");
    setModuleError("");
    setModuleMessage("");
  };

  const handleManualUpi = async () => {
    const utrReference = manualUpiReference.trim();
    if (!utrReference) {
      setModuleError("Enter the UTR / transaction reference to submit manual UPI payment.");
      return;
    }
    setModuleError("");
    setModuleMessage("");
    try {
      await submitModuleManualUpiRequest(manualUpiOfferId, {
        utrReference,
        paymentDate: new Date().toISOString(),
      });
      setManualUpiOfferId("");
      setManualUpiReference("");
      setModuleMessage("Manual UPI payment submitted. Activation waits for super-admin verification.");
      await refreshModules();
    } catch (error) {
      setModuleError(error.response?.data?.message || "Unable to submit manual UPI payment");
    }
  };

  return (
    <div className="space-y-6">
      <BillingEntitySettings />
      <header><h2 className="text-2xl font-semibold">Billing Company Settings</h2><p className="mt-1 text-sm text-slate-500">Manage your company, GST, invoices and payment details.</p></header>
      <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
        {["Business Profile", "GST & Tax", "Invoice & Payment", "Branding", "Communications", ...(visibility.inventory ? ["Inventory"] : [])].map(label => <button key={label} type="button" onClick={() => { setSection(label); setSaveError(""); setFieldErrors({}); setSaved(false); }} aria-pressed={section === label} className={section === label ? "rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white" : "rounded-xl border px-3 py-2 text-sm"}>{label}</button>)}
      </nav>
      <section className="mx-auto w-full max-w-5xl space-y-4">
        {section !== "Communications" && <form onSubmit={handleProfileSubmit} className="rounded-2xl border bg-white p-4 sm:p-6 dark:bg-slate-900">
          <h3 className="mb-4 text-lg font-semibold">{section}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {section === "Inventory" && visibility.inventory && <label className="flex items-center gap-2"><input type="checkbox" name="allowNegativeStock" checked={form.allowNegativeStock} onChange={handleChange} />Allow negative stock when recording stock out</label>}
            {(section === "Business Profile" ? [["name", "Legal billing company name"], ["industry", "Industry"], ["email", "Business email"], ["billingEmail", "Billing email"], ["phone", "Phone"], ["address", "Address"]] : section === "Invoice & Payment" ? [["invoicePrefix", "Invoice prefix"], ["invoiceNumberingFormat", "Invoice numbering format"], ["bankAccountName", "Account holder name"], ["bankName", "Bank name"], ["bankAccountNumber", "Account number"], ["bankIfscCode", "IFSC"], ["bankUpiId", "UPI ID"]] : []).map(([name, label]) => <label key={name} className="min-w-0"><span className="mb-1 block text-sm font-medium">{label}</span><input name={name} type={name.toLowerCase().includes("email") ? "email" : "text"} value={form[name]} readOnly={name === "industry" && isRealEstateSelfHosted} onChange={handleChange} className="w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm" />{fieldErrors[name] && <span className="mt-1 block text-xs text-rose-600">{fieldErrors[name]}</span>}</label>)}
            {section === "GST & Tax" && <>
              <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" name="gstEnabled" disabled={business?.billingEntityCode === "GOLDHAWK"} checked={form.gstEnabled} onChange={handleChange} />GST Registered</label>
              {form.gstEnabled && <>
                <label><span className="mb-1 block text-sm">GSTIN</span><input name="gstConfigurationGstin" value={form.gstConfigurationGstin} maxLength={15} onChange={handleChange} className="w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm" /></label>
                <label><span className="mb-1 block text-sm">State</span><select name="gstStateCode" value={form.gstStateCode} onChange={handleChange} className="w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm"><option value="">Select state</option>{Object.entries(gstStates).map(([code, state]) => <option key={code} value={code}>{state} ({code})</option>)}</select></label>
                <label><span className="mb-1 block text-sm">State Code</span><input value={form.gstStateCode} readOnly className="w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm" /></label>
              </>}
              <label><span className="mb-1 block text-sm">Default GST Rate</span><select name="taxRate" disabled={business?.billingEntityCode === "GOLDHAWK"} value={form.taxRate} onChange={handleChange} className="w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm">{Array.from(new Set([0, 5, 12, 18, 28, Number(form.taxRate)])).sort((a,b) => a-b).map(rate => <option key={rate} value={rate}>{rate}%</option>)}</select></label>
              <div><p className="text-sm font-medium">Tax calculation: Tax Exclusive</p><p className="mt-1 text-xs text-slate-500">{business?.billingEntityCode === "GOLDHAWK" ? "Goldhawk invoices are non-GST. Tax is always zero." : "GST is added to the entered rate. Each item uses its own GST rate."}</p></div>
            </>}
            {section === "Invoice & Payment" && <label className="sm:col-span-2"><span className="mb-1 block text-sm">Invoice terms</span><textarea name="invoiceTerms" rows={3} value={form.invoiceTerms} onChange={handleChange} className="w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm" /></label>}
            {section === "Branding" && <>
              <BrandImageUpload
                title="Business logo"
                description="Shown with your business details when available."
                previewUrl={logoPreviewUrl}
                previewAlt="Business logo"
                buttonLabel={logoPreviewUrl ? "Change logo" : "Upload logo"}
                onFile={(file) => { setSaveError(""); setSaved(false); setRemoveLogo(false); setLogoFile(file); }}
                onRemove={() => { setSaved(false); setLogoFile(null); setRemoveLogo(Boolean(business?.logoUrl)); }}
                onError={setSaveError}
              />
              <BrandImageUpload
                title="Authorised signature"
                description="Printed at the bottom of client invoice PDFs. A transparent PNG works best."
                previewUrl={signaturePreviewUrl}
                previewAlt="Authorised signature"
                buttonLabel={signaturePreviewUrl ? "Change signature" : "Upload signature"}
                onFile={(file) => { setSaveError(""); setSaved(false); setRemoveSignature(false); setSignatureFile(file); }}
                onRemove={() => { setSaved(false); setSignatureFile(null); setRemoveSignature(Boolean(business?.signatureUrl)); }}
                onError={setSaveError}
                contain
                acceptedTypes={["image/jpeg", "image/png"]}
              />
            </>}
          </div>
          {saveError && <p role="alert" className="mt-4 text-sm text-rose-600">{saveError}</p>}
          {saved && <p role="status" className="mt-4 text-sm text-emerald-600">Saved successfully</p>}
          <button type="submit" disabled={isSaving} className="mt-4 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{isSaving ? "Saving..." : "Save changes"}</button>
        </form>}
        <div className={section === "Communications" ? "space-y-4" : "hidden"}>
          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <p className="text-sm font-semibold text-white">Communication providers</p>
            <p className="mt-2 text-sm text-slate-300">
              Email and WhatsApp delivery are available once connected. Check your current delivery status below.
            </p>
            <div className="mt-4 grid gap-2 text-sm text-slate-300">
              <ProviderStatus label="WhatsApp Business API" configured={communicationSummary?.providerStatus?.whatsapp?.configured} />
              <ProviderStatus label="Email delivery" configured={communicationSummary?.providerStatus?.email?.configured} />
              <ProviderStatus label="SMS provider" configured={communicationSummary?.providerStatus?.sms?.configured} />
            </div>
          </div>

          {!isRealEstateSelfHosted ? <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white">External Integration API</p>
                <p className="mt-2 text-sm text-slate-300">
                  Connect websites, CRMs, and future Nemnidhi flows without exposing internal admin APIs.
                </p>
              </div>
              <button type="button" onClick={handleCreateIntegrationKey} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">Create key</button>
            </div>
            {newIntegrationKey ? (
              <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold text-emerald-200">Copy this key now. It will not be shown again.</p>
                    <p className="mt-1 text-xs text-emerald-100/80">BillStack stores only the key prefix and hash after creation.</p>
                  </div>
                  <button type="button" onClick={() => setNewIntegrationKey("")} className="rounded-lg border border-emerald-300/30 px-3 py-1.5 text-xs font-semibold text-emerald-100">
                    Done
                  </button>
                </div>
                <code className="mt-2 block break-all text-xs text-emerald-100">{newIntegrationKey}</code>
              </div>
            ) : null}
            {integrationError ? <p className="mt-3 text-sm text-rose-400">{integrationError}</p> : null}
            <div className="mt-4 space-y-2">
              {integrationCredentials.length ? integrationCredentials.map((credential) => (
                <div key={credential._id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[.03] px-3 py-2 text-sm text-slate-300">
                  <span>{credential.name} · {credential.source} · {credential.keyPrefix}••••</span>
                  <button type="button" disabled={credential.status === "REVOKED"} onClick={() => setPendingRevokeCredential(credential)} className="text-xs text-rose-300 disabled:text-slate-500">
                    {credential.status === "REVOKED" ? "Revoked" : "Revoke"}
                  </button>
                </div>
              )) : <p className="text-sm text-slate-400">No integration keys yet.</p>}
            </div>
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Recent integration events</p>
              {integrationEvents.length ? integrationEvents.map((event) => (
                <p key={event._id} className="mt-2 text-xs text-slate-400">{event.source} · {event.externalOrderId} · {event.status}</p>
              )) : <p className="mt-2 text-xs text-slate-500">No events yet.</p>}
            </div>
          </div> : null}

          {!isRealEstateSelfHosted && <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <p className="text-sm font-semibold text-white">Account security</p>
            <p className="mt-2 text-sm text-slate-300">
              Google login is linked server-side by verified email only. OAuth secrets are never exposed to the browser.
            </p>
            <p className="mt-3 text-sm text-slate-300">
              Google account: <span className="font-semibold text-white">{user?.authProvider?.includes("google") ? "Linked" : "Not linked yet"}</span>
            </p>
          </div>

          }
          {shouldShowCommercialSettings(moduleData, business) ? <ModulesPanel
            moduleData={moduleData}
            moduleError={moduleError}
            moduleMessage={moduleMessage}
            onRequest={handleModuleRequest}
            onState={handleModuleState}
            onAccept={handleAcceptOffer}
            onDecline={handleDeclineOffer}
            onRazorpay={handleRazorpayAddon}
            onManualUpi={openManualUpi}
          /> : null}
        </div>
      </section>
      {pendingRevokeCredential ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[2rem] border border-white/10 bg-slate-900 p-6 shadow-2xl shadow-black/40">
            <h3 className="text-xl font-semibold text-white">Revoke integration key?</h3>
            <p className="mt-3 text-sm text-slate-300">
              This will immediately stop API authentication for{" "}
              <span className="font-semibold text-white">{pendingRevokeCredential.name}</span>.
              Existing events remain available for audit.
            </p>
            <p className="mt-3 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-xs text-slate-400">
              Key shown in list: {pendingRevokeCredential.keyPrefix}••••
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setPendingRevokeCredential(null)} className="rounded-2xl border border-white/10 px-5 py-3 text-sm font-semibold text-slate-200">
                Cancel
              </button>
              <button type="button" onClick={() => handleRevokeIntegrationKey(pendingRevokeCredential._id)} className="rounded-2xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white">
                Revoke key
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {manualUpiOfferId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[2rem] border border-white/10 bg-slate-900 p-6 shadow-2xl shadow-black/40">
            <h3 className="text-xl font-semibold text-white">Submit manual UPI payment</h3>
            <p className="mt-3 text-sm text-slate-300">
              Enter the UTR or transaction reference after completing payment. Super Admin verification is required before activation.
            </p>
            <label className="mt-5 block">
              <span className="mb-2 block text-sm font-medium text-slate-200">UTR / transaction reference</span>
              <input value={manualUpiReference} onChange={(event) => setManualUpiReference(event.target.value)} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-brand-500" />
            </label>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setManualUpiOfferId("")} className="rounded-2xl border border-white/10 px-5 py-3 text-sm font-semibold text-slate-200">
                Cancel
              </button>
              <button type="button" onClick={handleManualUpi} className="rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white">
                Submit for verification
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const ProviderStatus = ({ label, configured }) => (
  <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.03] px-3 py-2">
    <span>{label}</span>
    <span className={configured ? "text-emerald-300" : "text-amber-300"}>{configured ? "Configured" : "Not configured"}</span>
  </div>
);

const BrandImageUpload = ({ title, description, previewUrl, previewAlt, buttonLabel, onFile, onRemove, onError, contain = false, acceptedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"] }) => (
  <div className="min-w-0 rounded-2xl border p-4">
    <p className="text-sm font-semibold">{title}</p>
    <p className="mt-1 text-xs text-slate-500">{description}</p>
    <div className="mt-4 flex min-h-24 items-center justify-center rounded-xl border border-dashed bg-slate-50 p-3 dark:bg-slate-950/40">
      {previewUrl
        ? <img src={previewUrl} alt={previewAlt} className={`max-h-20 max-w-full ${contain ? "object-contain" : "rounded-lg object-contain"}`} />
        : <span className="text-xs text-slate-400">No image uploaded</span>}
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <label className="inline-flex cursor-pointer rounded-xl border px-3 py-2 text-sm font-medium">
        {buttonLabel}
        <input
          className="sr-only"
          type="file"
          accept={acceptedTypes.join(",")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (!acceptedTypes.includes(file.type) || file.size > 2 * 1024 * 1024) {
              onError(`Choose ${acceptedTypes.length === 2 ? "JPG or PNG" : "JPG, PNG, WEBP or GIF"} up to 2 MB`);
              event.target.value = "";
              return;
            }
            onFile(file);
          }}
        />
      </label>
      {previewUrl ? <button type="button" onClick={onRemove} className="rounded-xl border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 dark:border-rose-900/70 dark:text-rose-300">Remove</button> : null}
    </div>
    <p className="mt-2 text-xs text-slate-500">{acceptedTypes.length === 2 ? "JPG or PNG" : "JPG, PNG, WEBP or GIF"}. Maximum 2 MB.</p>
  </div>
);

const formatMoney = (value) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));

const ModulesPanel = ({ moduleData, moduleError, moduleMessage, onRequest, onState, onAccept, onDecline, onRazorpay, onManualUpi }) => {
  const modules = moduleData?.catalog || [];
  const isSelfHosted = moduleData?.deploymentMode === "SELF_HOSTED";
  const groups = {
    ACTIVE: modules.filter((item) => item.state === "ACTIVE"),
    AVAILABLE: modules.filter((item) => item.state === "AVAILABLE"),
    REQUEST: modules.filter((item) => item.state === "REQUEST_REQUIRED" || item.commercialState === "REQUESTED"),
    OFFERS: modules.filter((item) => ["OFFER_RECEIVED", "PAYMENT_PENDING"].includes(item.commercialState)),
    DISABLED: modules.filter((item) => item.state === "DISABLED"),
  };

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
      <div>
        <p className="text-sm font-semibold text-white">Modules & Add-ons</p>
        <p className="mt-2 text-sm text-slate-300">
          Deployment mode: <span className="font-semibold text-white">{moduleData?.deploymentMode || "SAAS"}</span>. Core financial modules are protected from accidental disablement.
        </p>
      </div>
      {moduleError ? <p className="mt-3 text-sm text-rose-300">{moduleError}</p> : null}
      {moduleMessage ? <p className="mt-3 text-sm text-emerald-300">{moduleMessage}</p> : null}
      <div className="mt-5 space-y-5">
        {Object.entries(groups).map(([group, items]) => (
          <section key={group}>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{group}</p>
            <div className="mt-3 grid gap-3">
              {items.length ? items.map((item) => (
                <div key={item.key} className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-semibold text-white">{item.name}</p>
                      <p className="mt-1 text-sm text-slate-400">{item.description}</p>
                      {item.dependencies?.length ? <p className="mt-2 text-xs text-slate-500">Depends on: {item.dependencies.join(", ")}</p> : null}
                      {item.commercial ? (
                        <p className="mt-2 text-xs text-slate-400">
                          {item.commercial.commercialType.replace("_", " ")}
                          {item.commercial.defaultPrice > 0 ? ` · Standard ${formatMoney(item.commercial.defaultPrice)} + GST` : ""}
                        </p>
                      ) : null}
                      {item.latestOffer ? (
                        <div className="mt-3 rounded-xl border border-brand-400/20 bg-brand-500/10 p-3 text-xs text-slate-200">
                          <p className="font-semibold text-white">Offer: {formatMoney(item.latestOffer.finalAmount)} total</p>
                          <p className="mt-1">Base {formatMoney(item.latestOffer.subtotal)} · GST {formatMoney(item.latestOffer.taxAmount)} · Status {item.latestOffer.status}</p>
                        </div>
                      ) : null}
                      {item.latestOrder ? (
                        <p className="mt-2 text-xs text-amber-200">Payment: {item.latestOrder.paymentStatus} · Activation: {item.latestOrder.activationStatus}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {item.commercialState === "OFFER_RECEIVED" && item.latestOffer ? (
                        <>
                          <button type="button" onClick={() => onAccept(item.latestOffer._id)} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white">Accept offer</button>
                          <button type="button" onClick={() => onDecline(item.latestOffer._id)} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">Decline</button>
                        </>
                      ) : null}
                      {item.commercialState === "PAYMENT_PENDING" && item.latestOffer ? (
                        <>
                          <button type="button" onClick={() => onRazorpay(item.latestOffer._id)} className="rounded-xl bg-brand-600 px-3 py-2 text-xs font-semibold text-white">Pay online</button>
                          <button type="button" onClick={() => onManualUpi(item.latestOffer._id)} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">Manual UPI</button>
                        </>
                      ) : null}
                      {item.state === "ACTIVE" && !item.protected ? (
                        <button type="button" onClick={() => onState(item.key, "DISABLED")} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200">Disable</button>
                      ) : null}
                      {(item.state === "AVAILABLE" || item.state === "DISABLED") && !["OFFER_RECEIVED", "PAYMENT_PENDING"].includes(item.commercialState) ? (
                        <button type="button" onClick={() => onState(item.key, "ACTIVE")} className="rounded-xl bg-brand-600 px-3 py-2 text-xs font-semibold text-white">Enable</button>
                      ) : null}
                      {item.state === "REQUEST_REQUIRED" && isSelfHosted ? (
                        <span className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100">Contact Nemnidhi to activate this module</span>
                      ) : null}
                      {item.state === "REQUEST_REQUIRED" && !isSelfHosted && item.commercialState !== "REQUESTED" ? (
                        <button type="button" onClick={() => onRequest(item.key)} className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100">Request</button>
                      ) : null}
                      {item.commercialState === "REQUESTED" && !isSelfHosted ? (
                        <span className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-400">Requested</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              )) : <p className="text-sm text-slate-500">No modules in this section.</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

export default BusinessSettingsPage;
