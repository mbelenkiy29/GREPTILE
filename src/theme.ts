// Light, dark or System (follows the operating system). The choice is kept in a first-party cookie
// that only the browser reads: an inline <head> script applies it to <html data-theme> before first
// paint, so the server never reads it and public pages can be prerendered.
export const themeCookie = "openreview_theme";
export type Theme = "system" | "light" | "dark";

/** The saved choice in a `document.cookie` string; System when none is saved. */
export function readTheme(cookies: string): Theme {
  for (const part of cookies.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === themeCookie && (value === "light" || value === "dark")) return value;
  }
  return "system";
}
/** A `document.cookie` assignment that stores the choice for a year. */
export function themeCookieValue(theme: Theme, secure: boolean) {
  return `${themeCookie}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
/** Runs inline in <head>, before the body paints: the same rule as readTheme, without imports. */
export const themeScript = `try{var m=document.cookie.match(/(?:^|;\\s*)${themeCookie}=(light|dark)(?:;|$)/);document.documentElement.dataset.theme=m?m[1]:"system"}catch(e){}`;
