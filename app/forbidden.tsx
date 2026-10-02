import Link from "next/link";

/** Rendered (with a 403 status) when `requireOrg({ permission })` finds the user's role lacks the permission. */
export default function Forbidden() {
  return (
    <main className="shell auth-page">
      <div className="auth-card">
        <span className="brand">OpenReview</span>
        <h1>You don&apos;t have access</h1>
        <p className="dim">Your role in this organization doesn&apos;t allow this. Ask an owner or admin if you need it.</p>
        <Link className="button" href="/dashboard">
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
