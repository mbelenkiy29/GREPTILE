// Browser setup for error tracking (Sentry) and product analytics (PostHog). Each starts only
// when its public key was set at build time; see docs/observability.md.
import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import { posthogBeforeSend, posthogHosts, posthogProxyPath, posthogToken, scrubBreadcrumb, scrubSentryEvent, sentryDataCollection, sentryDsn, telemetryEnvironment, tracesSampleRate } from "./src/telemetry";

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

if (posthogToken)
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

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
