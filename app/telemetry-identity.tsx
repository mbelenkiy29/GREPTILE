"use client";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { withLoadedAnalytics } from "../src/analytics-loader";
import { analyticsStartedEvent } from "../src/consent";
import { sentryDsn } from "../src/telemetry";

/** Ties analytics and error reports to the signed-in user and active workspace, by internal id only. */
export function TelemetryIdentity({ userId, workspaceId }: { userId: string; workspaceId?: string }) {
  useEffect(() => {
    // PostHog runs only after analytics consent, which may come later on this same page.
    const identify = () => withLoadedAnalytics((a) => a.identifyAnalytics(userId, workspaceId));
    identify();
    window.addEventListener(analyticsStartedEvent, identify);
    if (sentryDsn) {
      Sentry.setUser({ id: userId });
      Sentry.setTag("workspace_id", workspaceId ?? "none");
    }
    return () => window.removeEventListener(analyticsStartedEvent, identify);
  }, [userId, workspaceId]);
  return null;
}

/** A sign-out form that also forgets the user in this browser's analytics and error reports. */
export function SignOutForm({ action, label }: { action: () => Promise<void>; label: string }) {
  return <form action={action} onSubmit={() => {
    withLoadedAnalytics((a) => a.resetAnalytics());
    if (sentryDsn) Sentry.setUser(null);
  }}><button className="small">{label}</button></form>;
}
