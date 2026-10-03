import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icons";
import { Brand } from "./Brand";
import { activeNavId, NAV_ITEMS } from "./nav";

/** The sidebar navigation; the current section has `aria-current="page"`. */
export function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const active = activeNavId(pathname);
  return (
    <nav className="nav" aria-label="Dashboard">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          className="nav-link"
          data-nav={item.id}
          aria-current={item.id === active ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name={item.icon} size={18} />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The signed-in app frame (R6.13): skip link, a sidebar (brand, nav, account, footer) that becomes a top bar with a
 * menu button below 960px, and the main content region. Rendering only — `AppShell` supplies the path and the
 * mobile-menu state.
 */
export function ShellFrame({
  pathname,
  menuOpen,
  onToggleMenu,
  onNavigate,
  account,
  tools,
  footer,
  children,
}: {
  pathname: string;
  menuOpen: boolean;
  onToggleMenu?: () => void;
  onNavigate?: () => void;
  /** Org switcher and user menu. */
  account: ReactNode;
  /** Small controls next to the account (theme toggle). */
  tools?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar-mobile">
        <button
          type="button"
          className="icon-button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls="app-sidebar"
          onClick={onToggleMenu}
        >
          <Icon name={menuOpen ? "close" : "menu"} size={20} />
        </button>
        <Brand size={24} />
        <span className="spacer" />
        {tools}
      </header>
      <aside className="sidebar" id="app-sidebar" data-open={menuOpen ? "true" : "false"} aria-label="Sidebar">
        <div className="sidebar-head row">
          <Brand />
        </div>
        <NavList pathname={pathname} onNavigate={onNavigate} />
        <div className="sidebar-foot">
          <div className="sidebar-account">{account}</div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            {footer}
            <span className="sidebar-tools">{tools}</span>
          </div>
        </div>
      </aside>
      <div className="main">
        <main id="main" className="main-inner" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
