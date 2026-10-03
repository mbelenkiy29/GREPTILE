import Link from "next/link";
import { ErrorPanel } from "@/components/ui/ErrorPanel";

/** Not found inside the dashboard (an unknown id, or a row that belongs to another organization). */
export default function DashboardNotFound() {
  return (
    <ErrorPanel
      icon="finding"
      code="404"
      title="Not found in this organization"
      actions={
        <>
          <Link className="button button-primary" href="/dashboard">
            Go to the overview
          </Link>
          <Link className="button" href="/orgs">
            Switch organization
          </Link>
        </>
      }
    >
      <p className="dim">It may have been removed, or it belongs to another organization. Switch organizations if you have access to it there.</p>
    </ErrorPanel>
  );
}
