import { cookies, headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { authEnv } from "@/lib/env";
import { PATH_HEADER, SESSION_COOKIE } from "@/lib/auth/cookies";
import { can, type Action } from "@/lib/auth/permissions";
import { signInPath } from "@/lib/auth/redirect";
import { authorizeRequest, resolveOrgContext, ssoStartPath, type OrgContext } from "@/lib/auth/request";
import { validateSessionToken, type ActiveSession } from "@/lib/auth/sessions";

/**
 * Server-side auth API for pages, layouts, server actions, and route handlers (R6.1). Every dashboard query is
 * scoped by the `orgId` returned here (R1.1), and every mutation names the permission it needs.
 */

export type { OrgContext } from "@/lib/auth/request";
export type { ActiveSession, SessionUser } from "@/lib/auth/sessions";

function sessionClock() {
  return { now: new Date(), ttlDays: authEnv().SESSION_TTL_DAYS };
}

/** The current request's session (validated and, when due, renewed), or null. Memoized per request. */
export const getSession = cache(async (): Promise<ActiveSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(db(), token, sessionClock());
});

const getOrgResolution = cache(async () => resolveOrgContext(db(), await getSession()));

async function signInRedirect(): Promise<never> {
  redirect(signInPath((await headers()).get(PATH_HEADER)));
}

/** The active org enforces SSO (R4.6): sign in through its connection, then come back to this page. */
async function ssoRedirect(connectionId: string): Promise<never> {
  redirect(ssoStartPath(connectionId, (await headers()).get(PATH_HEADER)));
}

/** The signed-in user's session; redirects to `/sign-in?next=` when signed out. */
export async function requireUser(): Promise<ActiveSession> {
  const session = await getSession();
  if (!session) return signInRedirect();
  return session;
}

/**
 * The signed-in user acting in their active org. Redirects to `/sign-in?next=` when signed out and to `/orgs` when
 * there is no active org (or the user was removed from it); renders the 403 page when `permission` is missing.
 */
export async function requireOrg(opts: { permission?: Action } = {}): Promise<OrgContext> {
  const res = await getOrgResolution();
  if (res.status === "signed_out") return signInRedirect();
  if (res.status === "no_org") redirect("/orgs");
  if (res.status === "sso_required") return ssoRedirect(res.connectionId);
  if (opts.permission && !can(res.ctx.role, opts.permission)) forbidden();
  return res.ctx;
}

/**
 * The signed-in user and their active org, or `ctx: null` when they have none (instead of redirecting to `/orgs`).
 * For pages, such as onboarding, that also serve users who have not picked an org yet.
 */
export async function requireUserOrg(): Promise<{ session: ActiveSession; ctx: OrgContext | null }> {
  const res = await getOrgResolution();
  if (res.status === "signed_out") return signInRedirect();
  if (res.status === "no_org") return { session: res.session, ctx: null };
  if (res.status === "sso_required") return ssoRedirect(res.connectionId);
  const session = await getSession();
  if (!session) return signInRedirect();
  return { session, ctx: res.ctx };
}

/** Route-handler variant of `requireOrg`: the org context, or a 401/403 JSON `Response` to return as is. */
export function requireOrgForRoute(req: Request, opts: { permission?: Action } = {}) {
  return authorizeRequest({ db: db(), clock: sessionClock() }, req, opts);
}
