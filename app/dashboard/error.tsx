"use client";
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Server errors (with a digest) were already reported by instrumentation.ts.
  useEffect(() => { if (!error.digest) Sentry.captureException(error); }, [error]);
  return (
    <main className="onboarding">
      <h1>Unable to load this workspace</h1>
      <p role="alert">
        Check your connection and access to the selected workspace. If the
        problem continues, inspect the server logs for the failing operation.
      </p>
      <button onClick={reset}>Try again</button>
      <Link className="button" href="/dashboard">
        Return to overview
      </Link>
    </main>
  );
}
