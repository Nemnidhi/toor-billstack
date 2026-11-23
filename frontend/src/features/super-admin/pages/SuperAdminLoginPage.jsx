import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthCard from "../../../components/ui/AuthCard";
import FormField from "../../../components/ui/FormField";
import { superAdminLoginRequest } from "../api";
import { superAdminStore } from "../../../store/superAdminStore";

const initialForm = {
  email: "",
  password: "",
  code: "",
};

const SuperAdminLoginPage = () => {
  const navigate = useNavigate();
  const { setSession } = superAdminStore();
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    setErrors({});
    setServerError("");
    setIsSubmitting(true);

    try {
      const data = await superAdminLoginRequest({
        email: form.email.trim(),
        password: form.password,
        ...(form.code.trim() ? { code: form.code.trim() } : {}),
      });
      setSession(data);
      navigate("/super-admin");
    } catch (error) {
      setErrors(error.response?.data?.errors || {});
      setServerError(error.response?.data?.message || "Super admin login failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthCard
      title="Super Admin Login"
      subtitle="Sign in to manage BillStack platform controls."
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <FormField
          label="Email"
          name="email"
          type="email"
          placeholder="admin@billstack.local"
          value={form.email}
          onChange={handleChange}
          error={errors.email}
        />
        <FormField
          label="Password"
          name="password"
          type="password"
          placeholder="Enter your platform password"
          value={form.password}
          onChange={handleChange}
          error={errors.password}
        />
        <FormField
          label="Code from the authenticator app (when the server has one set)"
          name="code"
          placeholder="123456"
          value={form.code}
          onChange={handleChange}
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
        />
        {serverError ? <p className="text-sm text-rose-600">{serverError}</p> : null}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isSubmitting ? "Signing in..." : "Enter super admin panel"}
        </button>
      </form>
      <div className="mt-4 text-right text-sm">
        <Link to="/login" className="text-slate-500">
          Back to business login
        </Link>
      </div>
    </AuthCard>
  );
};

export default SuperAdminLoginPage;
