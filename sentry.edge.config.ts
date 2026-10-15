// Edge runtime error tracking; loaded by instrumentation.ts only when a DSN is set.
import * as Sentry from "@sentry/nextjs";
import { scrubBreadcrumb, scrubSentryEvent, sentryDataCollection, sentryDsn, telemetryEnvironment, tracesSampleRate } from "./src/telemetry";

Sentry.init({
  dsn: sentryDsn,
  environment: telemetryEnvironment,
  tracesSampleRate: tracesSampleRate(),
  dataCollection: sentryDataCollection,
  beforeSend: scrubSentryEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
