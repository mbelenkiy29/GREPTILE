// Server and edge setup for error tracking. Without NEXT_PUBLIC_SENTRY_DSN nothing is loaded.
import * as Sentry from "@sentry/nextjs";
import { sentryDsn } from "./src/telemetry";

export async function register() {
  if (!sentryDsn) return;
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

// Errors from Server Components, route handlers and server actions.
export const onRequestError = Sentry.captureRequestError;
