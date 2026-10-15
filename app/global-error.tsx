"use client";
// Last-resort boundary for errors in the root layout: reports to Sentry (when configured) and
// shows a plain recovery page, since the layout and its styles did not render.
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { if (!error.digest) Sentry.captureException(error); }, [error]);
  return <html lang="en">
    <body>
      {/* Plain tokens from globals.css (light and dark), which this page cannot rely on. */}
      <style>{"body{margin:0;padding:48px 16px;font-family:system-ui,sans-serif;background:#f7f7f4;color:#26251e}main{max-width:480px;margin:0 auto}h1{font-size:22px}p{line-height:1.5}@media (prefers-color-scheme:dark){body{background:#14120b;color:#edecec}a{color:inherit}}"}</style>
      <main>
        <h1>Something went wrong</h1>
        <p role="alert">OpenReview could not load this page. Try again, or come back in a minute.</p>
        <p><button onClick={reset}>Try again</button> <Link href="/">Go to the home page</Link></p>
      </main>
    </body>
  </html>;
}
