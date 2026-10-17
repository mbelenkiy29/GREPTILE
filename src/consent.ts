// Analytics consent for the hosted site. PostHog starts, and sets its cookie, only after a visitor
// accepts. The choice is kept in a first-party cookie for 180 days. Do Not Track and Global
// Privacy Control count as a refusal, so those visitors are never asked. Sentry sets no cookies and
// is not gated.
export const consentCookie = "openreview_consent";
/** Fired on window to reopen the banner (the footer's "Cookie settings"). */
export const consentReopenEvent = "openreview:consent";
/** Fired on window once analytics has started, so the signed-in identity can attach. */
export const analyticsStartedEvent = "openreview:analytics";
export type Consent = "granted" | "denied";
type BrowserSignals = { doNotTrack?: string | null; globalPrivacyControl?: boolean };

/** The stored choice in a `document.cookie` string, if any. */
export function readConsent(cookies: string): Consent | undefined {
  for (const part of cookies.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === consentCookie && (value === "granted" || value === "denied")) return value;
  }
  return undefined;
}
/** A `document.cookie` assignment that stores the choice. */
export function consentCookieValue(choice: Consent, secure: boolean, maxAgeDays = 180) {
  return `${consentCookie}=${choice}; Path=/; Max-Age=${maxAgeDays * 86400}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
/** True when the browser itself asks not to be tracked. */
export function browserRefuses(signals: BrowserSignals) {
  return signals.doNotTrack === "1" || signals.globalPrivacyControl === true;
}
/** Show the banner: analytics is configured, no choice is stored, and the browser has not refused. */
export function needsChoice(configured: boolean, cookies: string, signals: BrowserSignals) {
  return configured && !readConsent(cookies) && !browserRefuses(signals);
}
/** Start analytics: the visitor accepted and the browser has not refused. */
export function analyticsAllowed(cookies: string, signals: BrowserSignals) {
  return readConsent(cookies) === "granted" && !browserRefuses(signals);
}
/** Names of PostHog's own cookies and storage keys (`ph_<token>_posthog`, `__ph_opt_in_out_…`). */
export const isAnalyticsStorageKey = (name: string) => name.startsWith("ph_") || name.startsWith("__ph");

/** Browser only: remove PostHog's cookies and storage, including any left from before the visitor
 *  was asked. It lives here, not in src/analytics.ts, so clearing never downloads PostHog. */
export function clearAnalyticsStorage() {
  for (const part of document.cookie.split(";")) {
    const name = part.trim().split("=")[0];
    if (name && isAnalyticsStorageKey(name)) for (const domain of ["", `; Domain=${location.hostname}`, `; Domain=.${location.hostname.replace(/^www\./, "")}`]) document.cookie = `${name}=; Path=/; Max-Age=0${domain}`;
  }
  try {
    for (const key of Object.keys(localStorage)) if (isAnalyticsStorageKey(key)) localStorage.removeItem(key);
    for (const key of Object.keys(sessionStorage)) if (isAnalyticsStorageKey(key)) sessionStorage.removeItem(key);
  } catch { /* storage blocked: nothing was stored */ }
}
