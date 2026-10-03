import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/shell/Brand";
import { Alert } from "@/components/ui/Alert";
import { demoEnv } from "@/lib/env";
import { TryForm } from "./TryForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Try it on a pull request",
  description: "Paste a public GitHub pull request and get a fast OpenReview review. Nothing is posted to GitHub.",
};

/** Public "Paste a PR" demo (R3.7): no account needed; abuse-protected; results are never posted to GitHub. */
export default function TryPage() {
  const env = demoEnv();
  return (
    <main className="auth-page">
      <div className="auth-card demo-card">
        <div className="stack-md">
          <Brand href="/" />
          <div className="stack-sm">
            <h1>Review a public pull request</h1>
            <p className="dim">
              Paste a link to a pull request in any public GitHub repository. OpenReview indexes the repository, reviews the change with its context in
              mind, and shows you what it found here. Nothing is posted to the pull request.
            </p>
          </div>
        </div>
        {env.DEMO_ENABLED ? (
          <>
            <TryForm />
            <ul className="dim demo-limits">
              <li>Fast mode: one quick pass over the change, verified before it is shown.</li>
              <li>
                Repositories up to {env.DEMO_MAX_REPO_MB} MB; pull requests up to {env.DEMO_MAX_PR_FILES} files and {env.DEMO_MAX_PR_ADDITIONS.toLocaleString("en-US")} added
                lines.
              </li>
              <li>{env.DEMO_PER_IP_PER_HOUR} reviews per hour per visitor. Results are deleted after {env.DEMO_RETENTION_HOURS} hours.</li>
            </ul>
          </>
        ) : (
          <Alert tone="info" title="The demo is off on this server">
            The operator of this OpenReview instance has not turned on the public demo (<code>DEMO_ENABLED</code>).
          </Alert>
        )}
        <p className="dim">
          Want reviews on your own repositories, with your team&apos;s rules and every mode? <Link href="/sign-in">Sign in and install OpenReview</Link>.
        </p>
      </div>
    </main>
  );
}
