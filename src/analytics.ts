// Browser only: starts and stops PostHog. It runs only after the visitor accepts analytics cookies
// (src/consent.ts); see docs/observability.md for what is collected. Load it through
// src/analytics-loader.ts, never import it directly, so visitors who never accept never download it.
import posthog from "posthog-js";
import { analyticsStartedEvent, clearAnalyticsStorage } from "./consent";
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

/** Ties analytics to the signed-in user and active workspace, by internal id only. */
export function identifyAnalytics(userId: string, workspaceId?: string) {
  if (!posthog.__loaded) return;
  posthog.identify(userId);
  if (workspaceId) posthog.register({ workspace_id: workspaceId });
  else posthog.unregister("workspace_id");
}

/** On sign-out: forget the user in this browser's analytics. */
export function resetAnalytics() {
  if (posthog.__loaded) posthog.reset();
}
