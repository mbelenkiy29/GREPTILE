import { Suspense } from "react";
import { cookies } from "next/headers";
import { api } from "../../convex/_generated/api";
import { backend } from "../../src/server";
import { posthogToken, sentryDsn } from "../../src/telemetry";
import { TelemetryIdentity } from "../telemetry-identity";
import { Toaster } from "../ui/toaster";
import { activeWorkspace } from "./load";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}<Suspense fallback={null}><Toaster /><Identity /></Suspense></>;
}

// The signed-in user for analytics and error reports. Never redirects: the pages handle sign-in.
async function Identity() {
  if (!posthogToken && !sentryDsn) return null;
  const jar = await cookies(), token = jar.get("openreview_session")?.value;
  const me = token ? await backend().query(api.users.me, { token }).catch(() => null) : null;
  if (!me) return null;
  return <TelemetryIdentity userId={me.user._id} workspaceId={activeWorkspace(me, jar)?._id} />;
}
