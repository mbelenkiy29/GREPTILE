/** Readable messages for `/sign-in?error=<code>` (R6.1). Unknown codes get a generic message. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  access_denied: "GitHub sign-in was cancelled. You can try again whenever you're ready.",
  invalid_state: "Your sign-in attempt expired or was started in another tab. Please sign in again.",
  missing_code: "GitHub didn't return an authorization code. Please sign in again.",
  exchange_failed: "GitHub didn't accept the sign-in. Please try again.",
  github_unavailable: "We couldn't reach GitHub. Check your connection and try again.",
  github_error: "GitHub reported a problem with the sign-in request. Please try again.",
  github_not_configured:
    "GitHub sign-in isn't configured on this server. An administrator needs to set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.",
  server_error: "Something went wrong while signing you in. Please try again.",
};

export function signInErrorMessage(code: string | undefined | null): string | null {
  if (!code) return null;
  return SIGN_IN_ERRORS[code] ?? "Sign-in failed. Please try again.";
}

/** Outcomes of the GitHub App install callback, shown on the Repositories page (R1.1). */
export const INSTALL_MESSAGES: Record<string, string> = {
  ok: "GitHub connected. Selected repositories are being indexed.",
  requested: "Your request to install the GitHub App was sent to an owner of that GitHub account. Repositories appear here once they approve it.",
  invalid_state: "The install link expired or was started by another user or organization. Please try again.",
  missing_installation: "GitHub did not return an installation. Please try again.",
  not_accessible: "Your GitHub account can't access that installation, so it wasn't connected.",
  owned_elsewhere: "That GitHub installation is already connected to another organization.",
  forbidden: "Only owners and admins can connect GitHub repositories.",
  github_unavailable: "We couldn't reach GitHub to verify the installation. Please try again.",
};
