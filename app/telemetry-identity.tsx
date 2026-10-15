"use client";
import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import { useEffect } from "react";
import { posthogToken, sentryDsn } from "../src/telemetry";

/** Ties analytics and error reports to the signed-in user and active workspace, by internal id only. */
export function TelemetryIdentity({ userId, workspaceId }: { userId: string; workspaceId?: string }) {
  useEffect(() => {
    if (posthogToken) {
      posthog.identify(userId);
      if (workspaceId) posthog.register({ workspace_id: workspaceId });
      else posthog.unregister("workspace_id");
    }
    if (sentryDsn) {
      Sentry.setUser({ id: userId });
      Sentry.setTag("workspace_id", workspaceId ?? "none");
    }
  }, [userId, workspaceId]);
  return null;
}

/** A sign-out form that also forgets the user in this browser's analytics and error reports. */
export function SignOutForm({ action, label }: { action: () => Promise<void>; label: string }) {
  return <form action={action} onSubmit={() => {
    if (posthogToken) posthog.reset();
    if (sentryDsn) Sentry.setUser(null);
  }}><button className="small">{label}</button></form>;
}
