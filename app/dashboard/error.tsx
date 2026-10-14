"use client";
import Link from "next/link";
export default function DashboardError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
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
