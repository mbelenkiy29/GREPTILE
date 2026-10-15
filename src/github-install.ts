// Where the GitHub App installation flow may return to after GitHub redirects back.
const returnPaths = ["/dashboard/onboarding/connect", "/dashboard/settings/providers", "/dashboard/repositories"] as const;
export const defaultInstallReturn = "/dashboard/repositories";
export function installReturnPath(value: unknown): string {
  return typeof value === "string" && (returnPaths as readonly string[]).includes(value) ? value : defaultInstallReturn;
}
export function installHref(organizationId: string, returnTo: string) {
  return `/api/github/install?organization=${encodeURIComponent(organizationId)}&returnTo=${encodeURIComponent(installReturnPath(returnTo))}`;
}
