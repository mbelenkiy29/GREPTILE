import Link from "next/link";
import { Brand } from "@/components/shell/Brand";
import { ErrorPanel } from "@/components/ui/ErrorPanel";

/** Rendered (with a 403 status) when `requireOrg({ permission })` finds the user's role lacks the permission. */
export default function Forbidden() {
  return (
    <main className="auth-page">
      <div className="stack" style={{ width: "100%", maxWidth: 520, justifyItems: "center" }}>
        <Brand />
        <ErrorPanel
          icon="shield"
          code="403"
          title="You don't have access"
          actions={
            <Link className="button button-primary" href="/dashboard">
              Back to the dashboard
            </Link>
          }
        >
          <p className="dim">Your role in this organization doesn&apos;t allow this. Ask an owner or admin if you need it.</p>
        </ErrorPanel>
      </div>
    </main>
  );
}
