// Where the GitHub App installation flow may return to after GitHub redirects back.
const returnPaths = ["/dashboard/onboarding/connect", "/dashboard/settings/providers", "/dashboard/repositories"] as const;
export const defaultInstallReturn = "/dashboard/repositories";
export function installReturnPath(value: unknown): string {
  return typeof value === "string" && (returnPaths as readonly string[]).includes(value) ? value : defaultInstallReturn;
}
export function installHref(organizationId: string, returnTo: string) {
  return `/api/github/install?organization=${encodeURIComponent(organizationId)}&returnTo=${encodeURIComponent(installReturnPath(returnTo))}`;
}

// Callback checks on the sealed install state: it must belong to the current user, who must still
// administer the target workspace when GitHub redirects back.
type Membership = { _id?: string; role: string };
export function installTarget(saved: Record<string, unknown>, userId: string, organizations: readonly Membership[]) {
  if (typeof saved.userId !== "string" || saved.userId !== userId) throw new Error("Installation was started by another session");
  const organizationId = typeof saved.organizationId === "string" ? saved.organizationId : "";
  const membership = organizations.find((o) => o._id === organizationId);
  if (!membership || !["owner", "admin"].includes(membership.role)) throw new Error("Workspace admin required");
  return { organizationId, returnTo: installReturnPath(saved.returnTo) };
}
/** The GitHub account id the installer authenticated as (fresh token first, then the legacy sign-in id). */
export function installerGithubId(credentials: Record<string, unknown>, legacyGithubId: number | undefined) {
  return typeof credentials.githubUserId === "number" ? credentials.githubUserId : legacyGithubId;
}
