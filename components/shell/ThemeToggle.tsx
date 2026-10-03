"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icons";
import { THEME_COOKIE, themeAttribute, type Theme } from "@/lib/ui/theme";

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };
const ICON = { system: "monitor", light: "sun", dark: "moon" } as const;

/** Cycles system → light → dark. The choice is stored in a cookie (one year) and applied immediately. */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const next = NEXT[theme];
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`${LABEL[theme]} (switch to ${LABEL[next].toLowerCase()})`}
      title={`${LABEL[theme]} — click for ${LABEL[next].toLowerCase()}`}
      data-theme-toggle={theme}
      onClick={() => {
        setTheme(next);
        const attr = themeAttribute(next);
        if (attr) document.documentElement.dataset.theme = attr;
        else delete document.documentElement.dataset.theme;
        const secure = window.location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
      }}
    >
      <Icon name={ICON[theme]} size={18} />
    </button>
  );
}
