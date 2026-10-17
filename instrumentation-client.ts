// Browser setup for error tracking (Sentry) and product analytics (PostHog). Each starts only
// when its public key was set at build time, and PostHog only after consent; see docs/observability.md.
import * as Sentry from "@sentry/nextjs";
import { loadAnalytics } from "./src/analytics-loader";
import { analyticsAllowed, clearAnalyticsStorage } from "./src/consent";
import { scrubBreadcrumb, scrubSentryEvent, sentryDataCollection, sentryDsn, telemetryEnvironment, tracesSampleRate } from "./src/telemetry";

if (sentryDsn)
  Sentry.init({
    dsn: sentryDsn,
    environment: telemetryEnvironment,
    tracesSampleRate: tracesSampleRate(),
    // No session replay: signed-in pages show customers' private code.
    dataCollection: sentryDataCollection,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });

// PostHog sets a cookie, so it starts only for visitors who accepted analytics (the banner in
// app/consent.tsx starts it on the spot when they accept). Everyone else keeps no PostHog cookie,
// including one left from a visit before consent was asked. PostHog itself downloads only then.
if (analyticsAllowed(document.cookie, navigator as Navigator & { globalPrivacyControl?: boolean })) void loadAnalytics().then((a) => a.startAnalytics());
else clearAnalyticsStorage();

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
