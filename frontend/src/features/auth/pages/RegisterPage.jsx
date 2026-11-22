import { useState } from "react";
import { Link } from "react-router-dom";
import AuthCard from "../../../components/ui/AuthCard";
import FormField from "../../../components/ui/FormField";
import GoogleAuthButton from "../components/GoogleAuthButton";
import { useAuth } from "../useAuth";
import { useSignupOpen } from "../useSignupOpen";

const initialForm = {
  name: "",
  email: "",
  password: "",
  businessName: "",
};

const RegisterPage = () => {
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { googleAuth, register } = useAuth();
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
  const signupOpen = useSignupOpen(true);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const handleGoogle = async (payload) => {
    if (isSubmitting) return;
    setServerError("");
    setErrors({});
    if (!form.businessName.trim()) {
      setErrors({ businessName: "Business name is required for Google signup." });
      return;
    }
    setIsSubmitting(true);
    try {
      await googleAuth({ ...payload, mode: "signup", businessName: form.businessName, name: form.name });
    } catch (error) {
      setServerError(error.response?.data?.message || "Google signup failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    setErrors({});
    setServerError("");
    setIsSubmitting(true);

    try {
      await register(form);
    } catch (error) {
      setErrors(error.response?.data?.errors || {});
      setServerError(error.response?.data?.message || "Registration failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (signupOpen === false) {
    return (
      <AuthCard title="Accounts are added by your administrator" subtitle="New accounts cannot be created from this page.">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Ask your administrator to add you from Team. You will get your sign-in details from them.
        </p>
        <p className="mt-4 text-sm text-slate-500">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-700">
            Sign in
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create account"
      subtitle="Set up your business workspace in a few details."
    >
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <FormField label="Full name" name="name" placeholder="Aarav Sharma" value={form.name} onChange={handleChange} error={errors.name} autoComplete="name" required />
        <FormField label="Business name" name="businessName" placeholder="Your business name" value={form.businessName} onChange={handleChange} error={errors.businessName} autoComplete="organization" required />
      </div>
      {googleClientId ? (
        <>
          <GoogleAuthButton mode="signup" businessName={form.businessName} name={form.name} onSuccess={handleGoogle} onError={setServerError} />
          <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400"><span className="h-px flex-1 bg-slate-200" />or create with email<span className="h-px flex-1 bg-slate-200" /></div>
        </>
      ) : null}
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
        <FormField label="Work email" name="email" type="email" placeholder="you@business.com" value={form.email} onChange={handleChange} error={errors.email} autoComplete="email" required />
        <FormField label="Password" name="password" type="password" placeholder="Create a secure password" value={form.password} onChange={handleChange} error={errors.password} autoComplete="new-password" required />
        {serverError ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700 sm:col-span-2">{serverError}</div> : null}
        <button
          type="submit"
          disabled={isSubmitting}
          className="auth-primary w-full rounded-2xl px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-70 sm:col-span-2"
        >
          {isSubmitting ? "Creating workspace..." : "Create account"}
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-500">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-brand-700">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
};

export default RegisterPage;
