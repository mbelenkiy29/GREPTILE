"use client";
import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import { useEffect } from "react";
import { analyticsStartedEvent } from "../src/consent";
import { sentryDsn } from "../src/telemetry";

/** Ties analytics and error reports to the signed-in user and active workspace, by internal id only. */
export function TelemetryIdentity({ userId, workspaceId }: { userId: string; workspaceId?: string }) {
  useEffect(() => {
    // PostHog runs only after analytics consent, which may come later on this same page.
    const identify = () => {
      if (!posthog.__loaded) return;
      posthog.identify(userId);
      if (workspaceId) posthog.register({ workspace_id: workspaceId });
      else posthog.unregister("workspace_id");
    };
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
    if (posthog.__loaded) posthog.reset();
    if (sentryDsn) Sentry.setUser(null);
  }}><button className="small">{label}</button></form>;
}
