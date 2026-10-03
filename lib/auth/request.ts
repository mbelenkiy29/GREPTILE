import type { Db } from "@/lib/db";
import { getMembership } from "@/lib/data/orgs";
import { can, type Action, type Role } from "./permissions";
import { sessionFromRequest, type ActiveSession, type SessionClock, type SessionUser } from "./sessions";

/** The signed-in user acting in their active org, as every authorized request sees it (R6.1). */
export interface OrgContext {
  sessionId: string;
  userId: string;
  user: SessionUser;
  orgId: string;
  orgName: string;
  orgSlug: string;
  personal: boolean;
  role: Role;
}

export type OrgResolution =
  | { status: "signed_out" }
  | { status: "no_org"; session: ActiveSession }
  | { status: "ok"; ctx: OrgContext };

/**
 * Resolves the session's active org, re-checking the membership on every request so removed members lose access
 * immediately. A session whose active org the user no longer belongs to resolves to `no_org`.
 */
export async function resolveOrgContext(db: Db, session: ActiveSession | null): Promise<OrgResolution> {
  if (!session) return { status: "signed_out" };
  if (!session.activeOrgId) return { status: "no_org", session };
  const membership = await getMembership(db, session.activeOrgId, session.userId);
  if (!membership) return { status: "no_org", session };
  return {
    status: "ok",
    ctx: {
      sessionId: session.id,
      userId: session.userId,
      user: session.user,
      orgId: membership.id,
      orgName: membership.name,
      orgSlug: membership.slug,
      personal: membership.personal,
      role: membership.role,
    },
  };
}

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Route-handler authorization: the org context, or a ready 401 (signed out) / 403 (no active org, or missing
 * permission) JSON response.
 */
export async function authorizeRequest(
  deps: { db: Db; clock: SessionClock },
  req: Request,
  opts: { permission?: Action } = {},
): Promise<{ ok: true; ctx: OrgContext } | { ok: false; response: Response }> {
  const res = await resolveOrgContext(deps.db, await sessionFromRequest(deps.db, req, deps.clock));
  if (res.status === "signed_out") return { ok: false, response: jsonError(401, "unauthenticated") };
  if (res.status === "no_org") return { ok: false, response: jsonError(403, "no_active_org") };
  if (opts.permission && !can(res.ctx.role, opts.permission)) {
    return { ok: false, response: jsonError(403, "forbidden", { permission: opts.permission }) };
  }
  return { ok: true, ctx: res.ctx };
}
