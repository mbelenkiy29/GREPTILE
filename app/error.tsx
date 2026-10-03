"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorPanel } from "@/components/ui/ErrorPanel";

/** Error boundary for pages outside the dashboard (sign-in, organizations, invitations). */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="auth-page">
      <div style={{ width: "100%", maxWidth: 520 }}>
        <ErrorPanel
          code="Something went wrong"
          title="This page couldn't be loaded"
          actions={
            <>
              <Button variant="primary" icon="refresh" onClick={() => reset()}>
                Try again
              </Button>
              <Link className="button" href="/">
                Home
              </Link>
            </>
          }
        >
          <p className="dim">Try again in a moment. If it keeps happening, an admin can check the server logs{error.digest ? " for this reference:" : "."}</p>
          {error.digest && <code>{error.digest}</code>}
        </ErrorPanel>
      </div>
    </main>
  );
}
