import BillingEntitySwitcher from "../../features/workspace/BillingEntitySwitcher";
import { Menu, Moon, Sun } from "lucide-react";
import { useAuth } from "../../features/auth/useAuth";
import { uiStore } from "../../store/uiStore";

const Navbar = () => {
  const { business, logout, user } = useAuth();
  const { openSidebar, theme, toggleTheme } = uiStore();
  const buttonStyle = { border: "1px solid var(--panel-border)", background: "color-mix(in srgb, var(--panel-bg) 92%, transparent)", color: "var(--text-primary)" };
  return <header className="sticky top-0 z-20 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8" style={{ borderBottom: "1px solid var(--panel-border)", background: "color-mix(in srgb, var(--panel-bg) 88%, transparent)" }}>
    <div className="flex items-center justify-between gap-4"><div className="flex min-w-0 items-center gap-3"><button type="button" onClick={openSidebar} aria-label="Open navigation" className="inline-flex rounded-xl p-2 lg:hidden" style={buttonStyle}><Menu size={19} /></button><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--text-muted)" }}>Business workspace</p><h1 className="truncate text-lg font-semibold">{business?.name || "Billing Command Center"}</h1></div></div><div className="flex items-center gap-2"><BillingEntitySwitcher /><button type="button" onClick={toggleTheme} aria-label="Toggle color theme" className="rounded-xl p-2.5" style={buttonStyle}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button><div className="hidden rounded-xl px-3 py-2 sm:block" style={buttonStyle}><p className="max-w-36 truncate text-sm font-medium">{user?.name || "Account"}</p><p className="max-w-36 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{user?.role || user?.email}</p></div><button onClick={logout} className="hidden rounded-xl px-3 py-2 text-sm sm:block" style={buttonStyle}>Logout</button></div></div>
  </header>;
};
export default Navbar;
