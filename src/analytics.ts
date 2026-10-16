// Browser only: starts and stops PostHog. It runs only after the visitor accepts analytics cookies
// (src/consent.ts); see docs/observability.md for what is collected.
import posthog from "posthog-js";
import { analyticsStartedEvent, isAnalyticsStorageKey } from "./consent";
import { posthogBeforeSend, posthogHosts, posthogProxyPath, posthogToken } from "./telemetry";

export function startAnalytics() {
  if (!posthogToken || posthog.__loaded) return;
  posthog.init(posthogToken, {
    api_host: posthogProxyPath,
    ui_host: posthogHosts().ui,
    defaults: "2026-05-30",
    // Anonymous visitors stay anonymous; profiles exist only for signed-in users.
    person_profiles: "identified_only",
    disable_session_recording: true,
    // Errors go to Sentry.
    capture_exceptions: false,
    respect_dnt: true,
    before_send: posthogBeforeSend,
  });
  window.dispatchEvent(new Event(analyticsStartedEvent));
}

/** After a refusal: stop capturing in this page and remove PostHog's cookie and storage. */
export function stopAnalytics() {
  if (posthog.__loaded) {
    posthog.opt_out_capturing();
    posthog.set_config({ disable_persistence: true });
  }
  clearAnalyticsStorage();
}

/** Remove PostHog's cookies and storage, including any left from before the visitor was asked. */
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
