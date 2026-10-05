import { Suspense, lazy } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import AppLayout from "../app/AppLayout";
import GuestRoute from "../components/ui/GuestRoute";
import NotFoundPage from "../components/ui/NotFoundPage";
import ProtectedRoute from "../components/ui/ProtectedRoute";
import RouteErrorPage from "../components/ui/RouteErrorPage";
import RouteFallback from "../components/ui/RouteFallback";
import SuperAdminGuestRoute from "../components/ui/SuperAdminGuestRoute";
import SuperAdminRoute from "../components/ui/SuperAdminRoute";
const AuthLayout = lazy(() => import("../components/layout/AuthLayout"));
const DashboardLayout = lazy(() => import("../components/layout/DashboardLayout"));
const ForgotPasswordPage = lazy(() => import("../features/auth/pages/ForgotPasswordPage"));
const LoginPage = lazy(() => import("../features/auth/pages/LoginPage"));
const OnboardingPage = lazy(() => import("../features/auth/pages/OnboardingPage"));
const RegisterPage = lazy(() => import("../features/auth/pages/RegisterPage"));
const ResetPasswordPage = lazy(() => import("../features/auth/pages/ResetPasswordPage"));
const BusinessSettingsPage = lazy(() => import("../features/dashboard/pages/BusinessSettingsPage"));
const CommunicationsPage = lazy(() => import("../features/dashboard/pages/CommunicationsPage"));
const CustomersPage = lazy(() => import("../features/dashboard/pages/CustomersPage"));
const DashboardHomePage = lazy(() => import("../features/dashboard/pages/DashboardHomePage"));
const ExpensesPage = lazy(() => import("../features/dashboard/pages/ExpensesPage"));
const InvoicesPage = lazy(() => import("../features/dashboard/pages/InvoicesPage"));
const InvoiceDetailPage = lazy(() => import("../features/dashboard/pages/InvoiceDetailPage"));
const InvoiceHandoffPage = lazy(() => import("../features/integrations/InvoiceHandoffPage"));
const ProductsPage = lazy(() => import("../features/dashboard/pages/ProductsPage"));
const PurchasesPage = lazy(() => import("../features/dashboard/pages/PurchasesPage"));
const ReportsPage = lazy(() => import("../features/dashboard/pages/ReportsPage"));
const AccountingReportsPage = lazy(() => import("../features/accounting/pages/AccountingReportsPage"));
const SalesLifecyclePage = lazy(() => import("../features/dashboard/pages/SalesLifecyclePage"));
const SubscriptionPage = lazy(() => import("../features/dashboard/pages/SubscriptionPage"));
const SuppliersPage = lazy(() => import("../features/dashboard/pages/SuppliersPage"));
const TeamPage = lazy(() => import("../features/dashboard/pages/TeamPage"));
const WorkflowPage = lazy(() => import("../features/dashboard/pages/WorkflowPage"));
const EmployeesPage = lazy(() => import("../features/hr/pages/EmployeesPage"));
const AttendancePage = lazy(() => import("../features/hr/pages/AttendancePage"));
const SalarySetupPage = lazy(() => import("../features/hr/pages/SalarySetupPage"));
const SuperAdminDashboardPage = lazy(() => import("../features/super-admin/pages/SuperAdminDashboardPage"));
const SuperAdminLoginPage = lazy(() => import("../features/super-admin/pages/SuperAdminLoginPage"));

const lazyElement = (node, title) => (
  <Suspense fallback={<RouteFallback title={title} />}>{node}</Suspense>
);

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        index: true,
        element: <Navigate to="/login" replace />,
      },
      { path: "integration/invoice-handoff", element: lazyElement(<InvoiceHandoffPage />, "Preparing invoice") },
      {
        element: <GuestRoute />,
        children: [
          {
            element: lazyElement(<AuthLayout />, "Loading authentication"),
            children: [
              { path: "login", element: lazyElement(<LoginPage />, "Opening login") },
              { path: "register", element: lazyElement(<RegisterPage />, "Opening registration") },
              { path: "forgot-password", element: lazyElement(<ForgotPasswordPage />, "Opening password reset") },
              { path: "reset-password", element: lazyElement(<ResetPasswordPage />, "Opening password reset") },
            ],
          },
        ],
      },
      {
        element: <ProtectedRoute requireOnboardingComplete={false} />,
        children: [{ path: "onboarding", element: lazyElement(<OnboardingPage />, "Opening onboarding") }],
      },
      {
        element: <SuperAdminGuestRoute />,
        children: [
          {
            element: lazyElement(<AuthLayout />, "Loading admin login"),
            children: [
              { path: "super-admin/login", element: lazyElement(<SuperAdminLoginPage />, "Opening super admin login") },
              { path: "admin/login", element: <Navigate to="/super-admin/login" replace /> },
            ],
          },
        ],
      },
      {
        element: <SuperAdminRoute />,
        children: [
          { path: "super-admin", element: lazyElement(<SuperAdminDashboardPage />, "Loading super admin panel") },
          { path: "admin", element: <Navigate to="/super-admin" replace /> },
        ],
      },
      {
        element: <ProtectedRoute />,
        children: [
          {
            path: "dashboard",
            element: lazyElement(<DashboardLayout />, "Loading workspace"),
            children: [
              { index: true, element: lazyElement(<DashboardHomePage />, "Loading dashboard") },
              {
                path: "invoices",
                element: lazyElement(<InvoicesPage />, "Loading invoices"),
              },
              {
                path: "invoices/:invoiceId",
                element: lazyElement(<InvoiceDetailPage />, "Loading invoice"),
              },
              {
                path: "quotes",
                element: lazyElement(<SalesLifecyclePage />, "Loading quotes"),
              },
              {
                path: "orders",
                element: lazyElement(<WorkflowPage />, "Loading orders"),
              },
              {
                path: "credit-notes",
                element: lazyElement(<SalesLifecyclePage />, "Loading credit notes"),
              },
              {
                path: "sales-returns",
                element: lazyElement(<SalesLifecyclePage />, "Loading sales returns"),
              },
              {
                path: "customers",
                element: lazyElement(<CustomersPage />, "Loading customers"),
              },
              {
                path: "products",
                element: lazyElement(<ProductsPage />, "Loading products"),
              },
              {
                path: "suppliers",
                element: lazyElement(<SuppliersPage />, "Loading suppliers"),
              },
              {
                path: "purchases",
                element: lazyElement(<PurchasesPage />, "Loading purchases"),
              },
              {
                path: "expenses",
                element: lazyElement(<ExpensesPage />, "Loading expenses"),
              },
              {
                path: "reports",
                element: lazyElement(<ReportsPage />, "Loading reports"),
              },
              {
                path: "accounting",
                element: lazyElement(<AccountingReportsPage />, "Loading accounting"),
              },
              {
                path: "accounting/*",
                element: lazyElement(<AccountingReportsPage />, "Loading accounting"),
              },
              {
                path: "communications",
                element: lazyElement(<CommunicationsPage />, "Loading communications"),
              },
              {
                path: "projects",
                element: lazyElement(<WorkflowPage />, "Loading projects"),
              },
              {
                path: "tasks",
                element: lazyElement(<WorkflowPage />, "Loading tasks"),
              },
              {
                path: "recurring-billing",
                element: lazyElement(<WorkflowPage />, "Loading recurring billing"),
              },
              {
                path: "appointments",
                element: lazyElement(<WorkflowPage />, "Loading appointments"),
              },
              {
                path: "production-jobs",
                element: lazyElement(<WorkflowPage />, "Loading production jobs"),
              },
              {
                path: "batches",
                element: lazyElement(<WorkflowPage />, "Loading batches"),
              },
              {
                path: "dispatches",
                element: lazyElement(<WorkflowPage />, "Loading dispatches"),
              },
              {
                path: "approvals",
                element: lazyElement(<WorkflowPage />, "Loading approvals"),
              },
              {
                path: "team",
                element: lazyElement(<TeamPage />, "Loading team"),
              },
              {
                path: "hr/employees",
                element: lazyElement(<EmployeesPage />, "Loading employees"),
              },
              {
                path: "hr/attendance",
                element: lazyElement(<AttendancePage />, "Loading attendance"),
              },
              {
                path: "hr/salary-setup",
                element: lazyElement(<SalarySetupPage />, "Loading salary setup"),
              },
              {
                path: "settings",
                element: lazyElement(<BusinessSettingsPage />, "Loading settings"),
              },
              {
                path: "subscription",
                element: lazyElement(<SubscriptionPage />, "Loading subscription"),
              },
            ],
          },
        ],
      },
      {
        path: "*",
        element: <NotFoundPage />,
      },
    ],
  },
]);
