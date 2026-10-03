import type { Db } from "@/lib/db";
import { auditUserAction } from "@/lib/data/audit";
import { completeInstallation, InstallationOwnershipError } from "@/lib/data/installations";
import type { repos } from "@/lib/db/schema";
import type { GitHost } from "@/lib/git/types";
import { signInstallState, verifyInstallState } from "@/lib/github/install-state";
import { errorMessage, log } from "@/lib/log";
import { appUrl, type AuthConfig } from "./config";
import { clearUserGitHubToken, getUserGitHubToken, GitHubUserTokenError, userCanAccessInstallation } from "./github-user";
import { pathWithQuery, redirectTo } from "./http";
import { can } from "./permissions";
import { signInPath } from "./redirect";
import { resolveOrgContext, ssoStartPath, type OrgContext } from "./request";
import { requestMetadata, sessionFromRequest } from "./sessions";

/**
 * GitHub App install flow (R1.1), as handler factories over injected dependencies.
 *
 * - GET /api/github/install: requires `repos.manage`; redirects to GitHub with a signed state binding org + user.
 * - GET /api/github/callback: the state must match the session's user and active org, and the signed-in user must
 *   be able to access `installation_id` according to GitHub (`GET /user/installations` with their own token). Only
 *   then is the installation linked to the org, so nobody can claim another account's installation by guessing its
 *   id. Without a usable GitHub user token the user is sent through GitHub sign-in and back to the callback.
 */

export interface InstallDeps {
  db: Db;
  config: AuthConfig & { appSlug: string };
  host: GitHost;
  /** Queues indexing for newly connected repositories. */
  enqueue: (rows: (typeof repos.$inferSelect)[]) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
}

type Gate = { ok: true; ctx: OrgContext } | { ok: false; response: Response };

async function requireRepoManager(deps: Pick<InstallDeps, "db" | "config">, req: Request, now: Date): Promise<Gate> {
  const { db, config } = deps;
  const res = await resolveOrgContext(db, await sessionFromRequest(db, req, { now, ttlDays: config.sessionTtlDays }));
  if (res.status === "signed_out") return { ok: false, response: redirectTo(appUrl(config, signInPath(pathWithQuery(req)))) };
  if (res.status === "no_org") return { ok: false, response: redirectTo(appUrl(config, "/orgs")) };
  if (res.status === "sso_required") return { ok: false, response: redirectTo(appUrl(config, ssoStartPath(res.connectionId, pathWithQuery(req)))) };
  if (!can(res.ctx.role, "repos.manage")) {
    return { ok: false, response: redirectTo(appUrl(config, "/dashboard/repos?install=forbidden")) };
  }
  return { ok: true, ctx: res.ctx };
}

/** GET /api/github/install */
export function createInstallStartHandler(factory: () => Pick<InstallDeps, "db" | "config" | "now">) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const now = (deps.now ?? (() => new Date()))();
    const gate = await requireRepoManager(deps, req, now);
    if (!gate.ok) return gate.response;
    const url = new URL(`${deps.config.githubWebUrl}/apps/${encodeURIComponent(deps.config.appSlug)}/installations/new`);
    // `?from=onboarding` (R6.2) brings the user back to the wizard after GitHub; it is recorded in the signed state.
    const from = new URL(req.url).searchParams.get("from") === "onboarding" ? "onboarding" : "repos";
    url.searchParams.set("state", signInstallState(deps.config.appSecret, gate.ctx.orgId, now.getTime(), gate.ctx.userId, from));
    return redirectTo(url.toString());
  };
}

/** GET /api/github/callback?installation_id=…&setup_action=install&state=… */
export function createInstallCallbackHandler(factory: () => InstallDeps) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const { db, config } = deps;
    const now = (deps.now ?? (() => new Date()))();
    const params = new URL(req.url).searchParams;
    const state = verifyInstallState(config.appSecret, params.get("state") ?? "", now.getTime());
    // Only a validly signed state picks the page to return to (a fixed list, never a URL from the request).
    const page = state?.returnTo === "onboarding" ? "/onboarding" : "/dashboard/repos";
    const back = (outcome: string) => redirectTo(appUrl(config, `${page}?install=${outcome}`));

    const gate = await requireRepoManager(deps, req, now);
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const logger = log.child({ orgId: ctx.orgId, userId: ctx.userId });

    // A user without permission to install on the account asked an admin to approve it; nothing to link yet.
    if (params.get("setup_action") === "request") return back("requested");

    if (!state || state.orgId !== ctx.orgId || state.userId !== ctx.userId) return back("invalid_state");
    const installationId = Number(params.get("installation_id"));
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return back("missing_installation");

    const reauthorize = () => redirectTo(appUrl(config, `/api/auth/github?next=${encodeURIComponent(pathWithQuery(req))}`));
    const token = await getUserGitHubToken(db, ctx.userId, now);
    if (!token) return reauthorize();

    let allowed: boolean;
    try {
      allowed = await userCanAccessInstallation(token, installationId, { fetch: deps.fetch, apiUrl: config.githubApiUrl });
    } catch (err) {
      if (err instanceof GitHubUserTokenError) {
        await clearUserGitHubToken(db, ctx.userId);
        return reauthorize();
      }
      logger.error("could not verify installation access", { installationId, error: errorMessage(err) });
      return back("github_unavailable");
    }
    if (!allowed) {
      logger.warn("install callback for an installation the user cannot access", { installationId });
      return back("not_accessible");
    }

    try {
      const { repos } = await completeInstallation(db, deps.host, { orgId: ctx.orgId, orgName: ctx.orgName, installationId });
      await deps.enqueue(repos);
      logger.info("GitHub App installation connected", { installationId, repos: repos.length });
      await auditUserAction(db, { orgId: ctx.orgId, userId: ctx.userId, ip: requestMetadata(req).ip, now }, {
        action: "installation.linked",
        targetType: "installation",
        targetId: installationId,
        metadata: { repositories: repos.length },
      });
      return back("ok");
    } catch (err) {
      if (err instanceof InstallationOwnershipError) return back("owned_elsewhere");
      throw err;
    }
  };
}
