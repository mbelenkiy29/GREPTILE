"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeSettingsTab, SETTINGS_TABS } from "./settings-tabs";

/** The Settings section's tab list; each tab is a route, so it works without JavaScript and is linkable. */
export function SettingsTabs() {
  const current = activeSettingsTab(usePathname() ?? "");
  return (
    <nav className="tabs" aria-label="Settings sections">
      {SETTINGS_TABS.map((t) => (
        <Link key={t.id} href={t.href} aria-current={t.id === current ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
