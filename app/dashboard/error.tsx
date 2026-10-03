"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorPanel } from "@/components/ui/ErrorPanel";

/**
 * Error boundary for dashboard pages: a plain-language message, the error digest to quote to an admin (the server
 * log has the details under it), and a retry. Never shows the stack trace or raw server message.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surfaces client-side render errors in the browser console for whoever is debugging; server errors are logged
    // on the server with the same digest.
    console.error(error);
  }, [error]);
  return (
    <ErrorPanel
      code="Something went wrong"
      title="This page couldn't be loaded"
      actions={
        <>
          <Button variant="primary" icon="refresh" onClick={() => reset()}>
            Try again
          </Button>
          <Link className="button" href="/dashboard">
            Go to the overview
          </Link>
        </>
      }
    >
      <p className="dim">
        It may be a temporary problem with the database or a background service. Try again in a moment; if it keeps happening, an admin can
        check the server logs{error.digest ? " for this reference:" : "."}
      </p>
      {error.digest && <code>{error.digest}</code>}
    </ErrorPanel>
  );
}
