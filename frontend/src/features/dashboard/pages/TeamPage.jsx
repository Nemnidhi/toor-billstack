import { useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/PageState";
import { authStore } from "../../../store/authStore";
import { uiStore } from "../../../store/uiStore";
import {
  createTeamMemberRequest,
  deleteTeamMemberRequest,
  listTeamMembersRequest,
  updateTeamMemberRequest,
} from "../../auth/api";

const roleOptions = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "staff", label: "Staff" },
  { value: "accountant", label: "Accountant" },
];

const roleDescriptions = {
  owner: "Full business control, billing, and team permissions.",
  admin: "Can manage operations, records, and most business settings.",
  staff: "Limited day-to-day access for routine work.",
  accountant: "Focused on invoices, payments, and reports.",
};

const roleBadgeClasses = {
  owner: "bg-violet-500/15 text-violet-300",
  admin: "bg-sky-500/15 text-sky-300",
  staff: "bg-slate-500/15 text-slate-300",
  accountant: "bg-amber-500/15 text-amber-300",
};

const initialForm = {
  name: "",
  email: "",
  password: "",
  role: "staff",
  isActive: true,
};

const TeamPage = () => {
  const { user, business } = authStore();
  const [filters, setFilters] = useState({
    page: 1,
    limit: 10,
    search: "",
    role: "",
    status: "",
    sortBy: "createdAt",
    sortOrder: "desc",
  });
  const [result, setResult] = useState({ items: [], pagination: { page: 1, totalPages: 1, total: 0 } });
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState("");
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const canManageTeam = ["owner", "admin"].includes(user?.role);

  const loadTeam = async () => {
    setIsLoading(true);
    setServerError("");

    try {
      const data = await listTeamMembersRequest(filters);
      setResult(data);
    } catch (error) {
      setServerError(
        error.response?.data?.message ||
          "Backend API is not reachable. Start the backend server and refresh this page."
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (canManageTeam) {
      loadTeam();
    } else {
      setIsLoading(false);
    }
  }, [canManageTeam, filters.page, filters.limit, filters.search, filters.role, filters.status, filters.sortBy, filters.sortOrder]);

  const handleFilterChange = (event) => {
    const { name, value } = event.target;
    setFilters((current) => ({ ...current, page: 1, [name]: value }));
  };

  const handleFormChange = (event) => {
    const { name, value, type, checked } = event.target;
    setForm((current) => ({ ...current, [name]: type === "checkbox" ? checked : value }));
  };

  const resetForm = () => {
    setEditingId("");
    setForm(initialForm);
    setErrors({});
    setServerError("");
  };

  const handleEdit = (member) => {
    setEditingId(member._id || member.id);
    setForm({
      name: member.name || "",
      email: member.email || "",
      password: "",
      role: member.role || "staff",
      isActive: member.isActive !== false,
    });
    setErrors({});
    setServerError("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsSaving(true);
    setErrors({});
    setServerError("");

    try {
      if (editingId) {
        const payload = {
          name: form.name,
          email: form.email,
          role: form.role,
          isActive: form.isActive,
        };

        if (form.password.trim()) {
          payload.password = form.password;
        }

        await updateTeamMemberRequest(editingId, payload);
      } else {
        await createTeamMemberRequest(form);
      }

      uiStore.getState().pushToast({
        tone: "success",
        message: editingId ? "Team member updated successfully." : "Team member invited successfully.",
      });
      resetForm();
      await loadTeam();
    } catch (error) {
      setErrors(error.response?.data?.errors || {});
      setServerError(error.response?.data?.message || "Unable to save team member");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (memberId) => {
    try {
      await deleteTeamMemberRequest(memberId);
      uiStore.getState().pushToast({
        tone: "success",
        message: "Team member removed successfully.",
      });
      await loadTeam();
    } catch (error) {
      setServerError(error.response?.data?.message || "Unable to delete team member");
    }
  };

  if (!canManageTeam) {
    return (
      <ErrorState
        title="Owner or admin access required"
        description="Only owner and admin accounts can manage team members and assign roles."
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-white/10 bg-white/5 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-brand-300">Team</p>
            <h2 className="mt-3 text-3xl font-semibold text-white">User roles and workspace access</h2>
            <p className="mt-3 max-w-3xl text-sm text-slate-400">
              Add teammates, assign roles, and deactivate access without affecting another business.
              Current plan: {business?.plan?.name || "Free"}.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <input name="search" value={filters.search} onChange={handleFilterChange} placeholder="Search name, email, role" className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
            <select name="role" value={filters.role} onChange={handleFilterChange} className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
              <option value="">All roles</option>
              {roleOptions.map((role) => (
                <option key={role.value} value={role.value}>{role.label}</option>
              ))}
            </select>
            <select name="status" value={filters.status} onChange={handleFilterChange} className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
              <option value="">All status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <select name="sortOrder" value={filters.sortOrder} onChange={handleFilterChange} className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <form onSubmit={handleSubmit} className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <h3 className="text-xl font-semibold text-white">{editingId ? "Edit user access" : "Add user / Grant access"}</h3>
          <p className="mt-2 text-sm text-slate-400">
            Assign role and billing privileges. Authorized users receive billing access to TOOR and Goldhawk.
          </p>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {roleOptions.map((role) => (
              <div key={role.value} className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${roleBadgeClasses[role.value]}`}>
                    {role.label}
                  </span>
                </div>
                <p className="mt-3 text-sm text-slate-300">{roleDescriptions[role.value]}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 grid gap-4">
            {[
              ["name", "Full name", "text"],
              ["email", "Email", "email"],
              ["password", editingId ? "New password (optional)" : "Password", "password"],
            ].map(([name, label, type]) => (
              <label key={name} className="block">
                <span className="mb-2 block text-sm text-slate-300">{label}</span>
                <input
                  type={type}
                  name={name}
                  value={form[name]}
                  onChange={handleFormChange}
                  className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white"
                />
                {errors[name] ? <span className="mt-2 block text-xs text-rose-400">{errors[name]}</span> : null}
              </label>
            ))}

            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Role</span>
              <select
                name="role"
                value={form.role}
                onChange={handleFormChange}
                className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white"
              >
                {roleOptions.map((role) => (
                  <option key={role.value} value={role.value}>{role.label}</option>
                ))}
              </select>
              {errors.role ? <span className="mt-2 block text-xs text-rose-400">{errors.role}</span> : null}
            </label>

            <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-200">
              <input
                type="checkbox"
                name="isActive"
                checked={form.isActive}
                onChange={handleFormChange}
              />
              Keep this account active
            </label>
          </div>

          {serverError ? <p className="mt-4 text-sm text-rose-400">{serverError}</p> : null}
          <div className="mt-5 flex gap-3">
            <button type="submit" disabled={isSaving} className="rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white">
              {isSaving ? "Saving..." : editingId ? "Update member" : "Create member"}
            </button>
            {editingId ? (
              <button type="button" onClick={resetForm} className="rounded-2xl border border-white/10 px-5 py-3 text-sm text-slate-200">
                Cancel
              </button>
            ) : null}
          </div>
        </form>

        <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-xl font-semibold text-white">Team list</h3>
            <p className="text-sm text-slate-400">{result.pagination.total} total</p>
          </div>
          {isLoading ? (
            <LoadingState title="Loading team" description="Fetching current business users and roles." />
          ) : serverError && !result.items.length ? (
            <ErrorState title="Unable to load team members" description={serverError} />
          ) : (
            <div className="space-y-3">
              {result.items.map((member) => {
                const memberId = member._id || member.id;
                const isSelf = memberId === user?.id;

                return (
                  <div key={memberId} className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-lg font-semibold text-white">{member.name}</p>
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${roleBadgeClasses[member.role] || roleBadgeClasses.staff}`}>
                            {roleOptions.find((role) => role.value === member.role)?.label || member.role}
                          </span>
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${member.isActive ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
                            {member.isActive ? "Active" : "Inactive"}
                          </span>
                          {isSelf ? (
                            <span className="rounded-full bg-brand-500/15 px-3 py-1 text-xs font-semibold text-brand-200">
                              You
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 grid gap-1 text-sm text-slate-300">
                          <p>{member.email}</p>
                          <p>{roleDescriptions[member.role] || "Business workspace access"}</p>
                          <p>Joined: {new Date(member.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleEdit(member)} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200">
                          Edit
                        </button>
                        {!isSelf ? (
                          <button onClick={() => handleDelete(memberId)} className="rounded-xl border border-rose-500/40 px-4 py-2 text-sm text-rose-300">
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!result.items.length ? (
                <EmptyState
                  title="No team members found"
                  description="Create your first admin, staff, or accountant account for this business."
                />
              ) : null}
            </div>
          )}
          <div className="mt-5 flex items-center justify-between">
            <button
              type="button"
              disabled={filters.page <= 1}
              onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200 disabled:opacity-40"
            >
              Previous
            </button>
            <p className="text-sm text-slate-400">
              Page {result.pagination.page} of {result.pagination.totalPages}
            </p>
            <button
              type="button"
              disabled={result.pagination.page >= result.pagination.totalPages}
              onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default TeamPage;
