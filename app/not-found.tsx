import Link from "next/link";
import { Brand } from "@/components/shell/Brand";
import { ErrorPanel } from "@/components/ui/ErrorPanel";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="auth-page">
      <div className="stack" style={{ width: "100%", maxWidth: 520, justifyItems: "center" }}>
        <Brand href="/" />
        <ErrorPanel
          icon="finding"
          code="404"
          title="We couldn't find that page"
          actions={
            <Link className="button button-primary" href="/dashboard">
              Go to the dashboard
            </Link>
          }
        >
          <p className="dim">The link may be out of date, or the page may belong to an organization you&apos;re not signed in to.</p>
        </ErrorPanel>
      </div>
    </main>
  );
}
