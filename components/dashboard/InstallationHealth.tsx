import { Alert } from "@/components/ui/Alert";

/** GitHub App permission names as GitHub's settings page shows them. */
const PERMISSION_LABEL: Record<string, string> = {
  contents: "Contents",
  pull_requests: "Pull requests",
  issues: "Issues",
  metadata: "Metadata",
  checks: "Checks",
  statuses: "Commit statuses",
  members: "Members",
};

/** "pull_requests:write" → "Pull requests: Read and write". */
export function describePermission(p: string): string {
  const [name = p, level] = p.split(":");
  const label = PERMISSION_LABEL[name] ?? name.replace(/_/g, " ");
  return level ? `${label}: ${level === "write" ? "Read and write" : level === "read" ? "Read-only" : level}` : label;
}

/**
 * Installation health banner (R1.1): a suspended installation, or one that lacks permissions reviews need, with
 * the exact permissions to grant on GitHub.
 */
export function InstallationHealth({
  installations,
}: {
  installations: { id: number; accountLogin: string; suspended: boolean; missingPermissions: string[] }[];
}) {
  if (!installations.length) return null;
  return (
    <div className="stack-sm" data-testid="installation-health">
      {installations.map((i) =>
        i.suspended ? (
          <Alert key={i.id} tone="error" title={`The GitHub App is suspended on ${i.accountLogin}`}>
            Reviews and indexing are paused for its repositories until an owner of {i.accountLogin} unsuspends the app in
            GitHub settings → Applications.
          </Alert>
        ) : (
          <Alert key={i.id} tone="warning" title={`The GitHub App on ${i.accountLogin} is missing permissions`}>
            <p>Grant these in GitHub settings → Applications → OpenReview → Permissions, then accept the update:</p>
            <ul style={{ margin: "6px 0 0", paddingLeft: "1.2em" }}>
              {i.missingPermissions.map((p) => (
                <li key={p}>
                  <strong>{describePermission(p)}</strong> <code>{p}</code>
                </li>
              ))}
            </ul>
          </Alert>
        ),
      )}
    </div>
  );
}
