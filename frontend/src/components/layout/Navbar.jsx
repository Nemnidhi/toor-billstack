import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, Menu, Moon, Sun } from "lucide-react";
import BillingEntitySwitcher from "../../features/workspace/BillingEntitySwitcher";
import { useAuth } from "../../features/auth/useAuth";
import { uiStore } from "../../store/uiStore";

const initialsFor = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "U";

const UserMenu = ({ user, onLogout }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="topbar-user"
      >
        <span className="topbar-avatar" aria-hidden="true">{initialsFor(user?.name)}</span>
        <span className="hidden min-w-0 text-left md:block">
          <span className="block max-w-36 truncate text-sm font-semibold">{user?.name || "Account"}</span>
          <span className="block max-w-36 truncate text-[11px] capitalize" style={{ color: "var(--text-muted)" }}>{user?.role || user?.email}</span>
        </span>
        <ChevronDown size={15} className="hidden shrink-0 md:block" style={{ color: "var(--text-muted)" }} />
      </button>
      {open ? (
        <div role="menu" className="topbar-menu">
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-semibold">{user?.name || "Account"}</p>
            <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{user?.email || user?.role}</p>
          </div>
          <div className="my-1 border-t" style={{ borderColor: "var(--panel-border)" }} />
          <button type="button" role="menuitem" onClick={onLogout} className="topbar-menu-item text-rose-600">
            <LogOut size={16} /> Log out
          </button>
        </div>
      ) : null}
    </div>
  );
};

const Navbar = () => {
  const { business, logout, user } = useAuth();
  const { openSidebar, theme, toggleTheme } = uiStore();

  return (
    <header className="topbar">
      <div className="flex min-w-0 items-center gap-3">
        <button type="button" onClick={openSidebar} aria-label="Open navigation" className="btn-icon lg:hidden">
          <Menu size={19} />
        </button>
        <span className="sidebar-logo sm:hidden" aria-hidden="true">B</span>
        <div className="hidden min-w-0 sm:block">
          <p className="text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>Business workspace</p>
          <p className="truncate text-[15px] font-semibold leading-tight">{business?.name || "Billing Command Center"}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <BillingEntitySwitcher />
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
          className="btn-icon"
        >
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <UserMenu user={user} onLogout={logout} />
      </div>
    </header>
  );
};

export default Navbar;
