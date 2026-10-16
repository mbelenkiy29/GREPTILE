// Offline mode (OPENREVIEW_OFFLINE=true): OpenReview only talks to the hosts an operator configured for
// its core work — the model and embedding endpoints, the code hosts (SCM), and SSO identity providers
// that workspace admins set up. Every other outbound call (vulnerability advisories, ticket and doc
// integrations, Slack, email, Stripe, Devin, Google sign-in, MCP client-metadata documents) is skipped,
// and feature tips are not shown. Callers check here before any network I/O.
export type Egress = "model" | "embedding" | "scm" | "sso" | "advisories" | "integrations" | "slack" | "email" | "billing" | "handoff" | "identity" | "oauth-client-metadata" | "tips";
const essential: Egress[] = ["model", "embedding", "scm", "sso"];
export const offline = (env: Record<string, string | undefined> = process.env) => env.OPENREVIEW_OFFLINE === "true";
export const egressAllowed = (kind: Egress, env: Record<string, string | undefined> = process.env) => !offline(env) || essential.includes(kind);
export class OfflineError extends Error { constructor(readonly kind: Egress, what: string) { super(`${what} is turned off in offline mode (OPENREVIEW_OFFLINE=true)`); this.name = "OfflineError"; } }
export function assertEgress(kind: Egress, what: string, env: Record<string, string | undefined> = process.env) {
  if (!egressAllowed(kind, env)) throw new OfflineError(kind, what);
}
