import { z } from "zod";

// SSO helpers safe for every runtime (Convex functions import these; network code lives in src/sso.ts).
export const domainSchema = z.string().trim().toLowerCase().max(253).regex(/^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, "Enter a domain such as example.com");
export const emailDomain = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";
export const verificationName = (domain: string) => `_openreview-challenge.${domain}`;
export const verificationValue = (token: string) => `openreview-domain-verification=${token}`;
// Verified email rule: the address's domain is verified for this connection, and an OIDC IdP did not
// say the address is unverified.
export function ssoEmailVerified(email: string | undefined, verifiedDomains: string[], idpVerified?: boolean) {
  if (!email || idpVerified === false) return false;
  return verifiedDomains.includes(emailDomain(email));
}

