/** Sign-in failures from SSO (R4.6), each with a stable code for `/sign-in?error=<code>`. */
export type SsoErrorCode =
  | "sso_not_found"
  | "sso_ambiguous"
  | "sso_disabled"
  | "sso_invalid_state"
  | "sso_idp_error"
  | "sso_unavailable"
  | "sso_misconfigured"
  | "sso_invalid_response"
  | "sso_email_unverified"
  | "sso_domain_not_allowed"
  | "sso_identity_linked"
  | "sso_use_primary_sign_in"
  | "rate_limited";

export class SsoError extends Error {
  constructor(
    readonly code: SsoErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SsoError";
  }
}

export const SSO_SIGN_IN_ERRORS: Record<SsoErrorCode, string> = {
  sso_not_found: "We couldn't find single sign-on for that email domain or organization. Check it, or sign in with GitHub.",
  sso_ambiguous: "Several organizations use single sign-on for that email domain. Enter your organization's slug instead.",
  sso_disabled: "Single sign-on is turned off for that organization. Ask an owner to enable it.",
  sso_invalid_state: "Your single sign-on attempt expired or was started in another tab. Please try again.",
  sso_idp_error: "Your identity provider reported a problem with the sign-in. Please try again.",
  sso_unavailable: "We couldn't reach your identity provider. Please try again in a moment.",
  sso_misconfigured: "Single sign-on for this organization is misconfigured. Ask an owner to check its settings.",
  sso_invalid_response: "Your identity provider's response could not be verified. Please try again.",
  sso_email_unverified: "Your identity provider didn't confirm a verified email address for your account.",
  sso_domain_not_allowed: "Your email domain isn't allowed to sign in to this organization.",
  sso_identity_linked: "That single sign-on identity is already linked to another OpenReview account.",
  sso_use_primary_sign_in: "This single sign-on identity belongs to an account that signs in with GitHub. Sign in with GitHub first; you will then be sent through single sign-on.",
  rate_limited: "Too many sign-in attempts. Wait a minute and try again.",
};
