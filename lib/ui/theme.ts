/** Color theme preference, persisted in a cookie so the server renders the right theme with no flash. */
export const THEME_COOKIE = "openreview_theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function parseTheme(value: unknown): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

/** The `data-theme` attribute for `<html>`: absent for "system" (CSS follows prefers-color-scheme). */
export function themeAttribute(theme: Theme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}
