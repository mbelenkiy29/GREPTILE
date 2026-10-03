/**
 * Settings sections, in tab order. Each is its own route under `/dashboard/settings`; a track that adds a section
 * (API keys, billing, SSO, model providers) appends an entry here and adds `app/dashboard/settings/<id>/page.tsx`.
 */
export interface SettingsTab {
  id: string;
  label: string;
  href: string;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", label: "General", href: "/dashboard/settings" },
  { id: "review", label: "Review defaults", href: "/dashboard/settings/review" },
  { id: "github", label: "GitHub", href: "/dashboard/settings/github" },
  { id: "api-keys", label: "API keys", href: "/dashboard/settings/api-keys" },
  { id: "model", label: "Model provider", href: "/dashboard/settings/model" },
  { id: "sso", label: "Single sign-on", href: "/dashboard/settings/sso" },
  { id: "audit", label: "Audit log", href: "/dashboard/settings/audit" },
];

/** The tab a settings path belongs to (`/dashboard/settings` itself is General). */
export function activeSettingsTab(pathname: string, tabs: readonly SettingsTab[] = SETTINGS_TABS): string | null {
  const path = pathname.replace(/[?#].*$/, "").replace(/\/+$/, "");
  let best: SettingsTab | null = null;
  for (const t of tabs) {
    if (path === t.href || path.startsWith(`${t.href}/`)) {
      if (!best || t.href.length > best.href.length) best = t;
    }
  }
  return best?.id ?? null;
}
