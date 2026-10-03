/**
 * Who is calling the REST API (R6.18). Two ways in:
 *
 * - `Authorization: Bearer or_live_…`: an API key. It acts as its org, limited to its scopes. Bearer tokens are not
 *   sent by browsers on their own, so no CSRF check applies.
 * - The dashboard's session cookie, for same-origin dashboard use. The session's active org and the member's role
 *   decide the scopes (reads for everyone; writes as the role permits). Cookies are ambient, so state-changing
 *   requests must come from the app's own origin (CSRF).
 *
 * The org is always derived from the key or the session, never from request input.
 */
import type { Db } from "@/lib/db";
import { can, type Action, type Role } from "@/lib/auth/permissions";
import { resolveOrgContext } from "@/lib/auth/request";
import { sessionFromRequest } from "@/lib/auth/sessions";
import { isSameOrigin } from "@/lib/security/csrf";
import { API_SCOPES, authenticateApiKey, type ApiScope } from "./keys";
import { ApiError } from "./http";

export type ApiActor =
  | { type: "api_key"; keyId: number; name: string; prefix: string }
  | { type: "user"; userId: string; name: string; role: Role };

export interface ApiPrincipal {
  orgId: string;
  orgName: string;
  orgSlug: string;
  scopes: ApiScope[];
  actor: ApiActor;
}

/** How the actor is recorded on runs (`requestedBy`), feedback, and logs: `api_key:<id>` or the user id. */
export function actorLabel(p: ApiPrincipal): string {
  return p.actor.type === "api_key" ? `api_key:${p.actor.keyId}` : p.actor.userId;
}

/** The audit log's actor columns for a principal. */
export function auditActor(p: ApiPrincipal): { actorType: "api_key" | "user"; actorId: string } {
  return p.actor.type === "api_key" ? { actorType: "api_key", actorId: String(p.actor.keyId) } : { actorType: "user", actorId: p.actor.userId };
}

/** Rate-limit bucket of a principal. */
export function rateLimitKey(p: ApiPrincipal): string {
  return p.actor.type === "api_key" ? `key:${p.actor.keyId}` : `user:${p.actor.userId}`;
}

/** Write scopes and the role permission a signed-in member needs for each. */
const WRITE_PERMISSION: Partial<Record<ApiScope, Action>> = {
  "repos:write": "repos.manage",
  "reviews:write": "reviews.trigger",
  "findings:write": "findings.feedback",
  "rules:write": "rules.manage",
};

/** Scopes a signed-in member holds: every read scope, and the write scopes their role permits. */
export function scopesForRole(role: Role): ApiScope[] {
  return API_SCOPES.filter((s) => {
    const permission = WRITE_PERMISSION[s];
    return permission === undefined ? s.endsWith(":read") : can(role, permission);
  });
}

export interface AuthDeps {
  db: Db;
  now: () => Date;
  appUrl: string;
  sessionTtlDays: number;
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

const KEY_FAILURE: Record<"malformed" | "unknown" | "revoked" | "expired", string> = {
  malformed: "The API key is not a valid OpenReview key.",
  unknown: "The API key is not valid.",
  revoked: "The API key has been revoked.",
  expired: "The API key has expired.",
};

function unauthorized(message: string): ApiError {
  return new ApiError(401, "unauthorized", message);
}

/**
 * Authenticates a request (bearer key first, else the session cookie) and, for cookie-authenticated requests that
 * change state, enforces the same-origin check. Throws {@link ApiError} (401 / 403) otherwise.
 */
export async function authenticateRequest(deps: AuthDeps, req: Request): Promise<ApiPrincipal> {
  const header = req.headers.get("authorization");
  if (header !== null) {
    const m = BEARER.exec(header);
    if (!m) throw unauthorized("Use `Authorization: Bearer <api key>`.");
    const result = await authenticateApiKey(deps.db, m[1]!, deps.now());
    if (!result.ok) throw unauthorized(KEY_FAILURE[result.reason]);
    const k = result.key;
    return {
      orgId: k.orgId,
      orgName: k.orgName,
      orgSlug: k.orgSlug,
      scopes: k.scopes,
      actor: { type: "api_key", keyId: k.id, name: k.name, prefix: k.prefix },
    };
  }

  const session = await sessionFromRequest(deps.db, req, { now: deps.now(), ttlDays: deps.sessionTtlDays });
  const resolution = await resolveOrgContext(deps.db, session);
  if (resolution.status === "signed_out") throw unauthorized("Authentication required: send an API key as `Authorization: Bearer <key>`.");
  if (resolution.status === "no_org") throw new ApiError(403, "forbidden", "Choose an organization in the dashboard first.");
  if (resolution.status === "sso_required") throw new ApiError(403, "forbidden", "This organization requires single sign-on. Sign in through SSO in the dashboard first.");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase()) && !isSameOrigin(req, deps.appUrl)) {
    throw new ApiError(403, "csrf_failed", "Cross-origin request refused. Use an API key for programmatic access.");
  }
  const ctx = resolution.ctx;
  return {
    orgId: ctx.orgId,
    orgName: ctx.orgName,
    orgSlug: ctx.orgSlug,
    scopes: scopesForRole(ctx.role),
    actor: { type: "user", userId: ctx.userId, name: ctx.user.name, role: ctx.role },
  };
}

/** Throws a 403 `insufficient_scope` unless the principal holds `scope`. */
export function requireScope(p: ApiPrincipal, scope: ApiScope): void {
  if (p.scopes.includes(scope)) return;
  throw new ApiError(
    403,
    "insufficient_scope",
    p.actor.type === "api_key" ? `This API key lacks the ${scope} scope.` : `Your role does not allow ${scope}.`,
  );
}
