import type { Db } from "@/lib/db";
import { defaultOrgForUser, ensurePersonalOrg } from "@/lib/data/orgs";
import { errorMessage, log } from "@/lib/log";
import { assertSameOrigin, CsrfError } from "@/lib/security/csrf";
import { appUrl, devLoginAllowed, GITHUB_CALLBACK_PATH, type AuthConfig } from "./config";
import {
  clearSessionCookies,
  issueSessionCookies,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  OAUTH_MAX_AGE_S,
  readCookie,
  secureCookies,
  serializeCookie,
  SESSION_COOKIE,
} from "./cookies";
import { exchangeOAuthCode, fetchGitHubProfile, GitHubSignInError } from "./github-user";
import { plainError, redirectTo } from "./http";
import { newOAuthState, openOAuthState, pkceChallenge, sealOAuthState, stateMatches } from "./oauth";
import { safeNextPath, signInPath } from "./redirect";
import { createSession, deleteSessionByToken, requestMetadata, sessionFromRequest } from "./sessions";
import { upsertDevUser, upsertGitHubUser } from "./users";

/**
 * Route handlers for built-in auth (R6.1), as factories over injected dependencies (database, fetch, clock,
 * config) so tests drive them with plain `Request` objects:
 *
 * - GET  /api/auth/github            → start GitHub sign-in (state + PKCE in a signed cookie)
 * - GET  /api/auth/github/callback   → finish sign-in, create the session
 * - POST /api/auth/logout            → end the session (same-origin only)
 * - POST /api/auth/dev               → local developer sign-in (AUTH_DEV_LOGIN, never in production)
 */

export interface AuthHandlerDeps {
  db: Db;
  config: AuthConfig;
  fetch?: typeof fetch;
  now?: () => Date;
}

type Factory<D> = () => D;

const clock = (deps: AuthHandlerDeps) => (deps.now ?? (() => new Date()))();

function oauthCookie(config: AuthConfig, value: string, maxAge: number): string {
  return serializeCookie(OAUTH_COOKIE, value, { maxAge, path: OAUTH_COOKIE_PATH, httpOnly: true, secure: secureCookies(config), sameSite: "lax" });
}

/**
 * Signs `userId` in on this browser. A valid session for the same user is kept (re-authorizing GitHub must not
 * log you out); a session for someone else is ended and replaced.
 */
async function startSession(deps: AuthHandlerDeps, req: Request, userId: string, now: Date): Promise<string[]> {
  const sessionClock = { now, ttlDays: deps.config.sessionTtlDays };
  const existing = await sessionFromRequest(deps.db, req, sessionClock);
  if (existing?.userId === userId) return [];
  if (existing) await deleteSessionByToken(deps.db, readCookie(req, SESSION_COOKIE));
  // Only an org the user is a member of; none (null) sends them to /orgs.
  const activeOrgId = await defaultOrgForUser(deps.db, userId);
  const { token } = await createSession(deps.db, { userId, activeOrgId, ...sessionClock, ...requestMetadata(req) });
  return issueSessionCookies(deps.config, token);
}

/** GET /api/auth/github?next=/path */
export function createGitHubSignInStartHandler(factory: Factory<AuthHandlerDeps>) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const { config } = deps;
    const next = safeNextPath(new URL(req.url).searchParams.get("next"));
    if (!config.githubClientId || !config.githubClientSecret) {
      return redirectTo(appUrl(config, signInPath(next, "github_not_configured")));
    }
    const state = newOAuthState(next, clock(deps).getTime());
    const authorize = new URL(`${config.githubWebUrl}/login/oauth/authorize`);
    authorize.searchParams.set("client_id", config.githubClientId);
    authorize.searchParams.set("redirect_uri", appUrl(config, GITHUB_CALLBACK_PATH));
    authorize.searchParams.set("state", state.state);
    authorize.searchParams.set("code_challenge", pkceChallenge(state.verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    return redirectTo(authorize.toString(), [oauthCookie(config, sealOAuthState(config.appSecret, state), OAUTH_MAX_AGE_S)]);
  };
}

/** GET /api/auth/github/callback?code=…&state=… */
export function createGitHubSignInCallbackHandler(factory: Factory<AuthHandlerDeps>) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const { config, db } = deps;
    const now = clock(deps);
    const params = new URL(req.url).searchParams;
    const clearState = oauthCookie(config, "", 0);
    const saved = openOAuthState(config.appSecret, readCookie(req, OAUTH_COOKIE), now.getTime());
    const fail = (code: string) => redirectTo(appUrl(config, signInPath(saved?.next, code)), [clearState]);

    const githubError = params.get("error");
    if (githubError) return fail(githubError === "access_denied" ? "access_denied" : "github_error");
    if (!saved || !stateMatches(saved, params.get("state"))) return fail("invalid_state");
    const code = params.get("code");
    if (!code || code.length > 512) return fail("missing_code");
    if (!config.githubClientId || !config.githubClientSecret) return fail("github_not_configured");

    try {
      const token = await exchangeOAuthCode(
        {
          code,
          codeVerifier: saved.verifier,
          redirectUri: appUrl(config, GITHUB_CALLBACK_PATH),
          clientId: config.githubClientId,
          clientSecret: config.githubClientSecret,
          now,
        },
        { fetch: deps.fetch, webUrl: config.githubWebUrl },
      );
      const profile = await fetchGitHubProfile(token.accessToken, { fetch: deps.fetch, apiUrl: config.githubApiUrl });
      const { user, created } = await upsertGitHubUser(db, { profile, token, now });
      await ensurePersonalOrg(db, user);
      const cookies = await startSession(deps, req, user.id, now);
      log.info("signed in with GitHub", { userId: user.id, githubLogin: profile.login, newUser: created });
      return redirectTo(appUrl(config, safeNextPath(saved.next)), [clearState, ...cookies]);
    } catch (err) {
      if (err instanceof GitHubSignInError) {
        log.warn("GitHub sign-in failed", { code: err.code, error: errorMessage(err) });
        return fail(err.code);
      }
      log.error("GitHub sign-in failed", { error: errorMessage(err) });
      return fail("server_error");
    }
  };
}

/** POST /api/auth/logout */
export function createLogoutHandler(factory: Factory<AuthHandlerDeps>) {
  return async (req: Request): Promise<Response> => {
    const { db, config } = factory();
    try {
      assertSameOrigin(req, config.appUrl);
    } catch (err) {
      if (err instanceof CsrfError) return plainError(403, "Cross-origin request refused.");
      throw err;
    }
    await deleteSessionByToken(db, readCookie(req, SESSION_COOKIE));
    return redirectTo(appUrl(config, "/sign-in"), clearSessionCookies(config), 303);
  };
}

/** POST /api/auth/dev (form field `next`). 404 unless dev login is enabled outside production. */
export function createDevLoginHandler(factory: Factory<AuthHandlerDeps>) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const { db, config } = deps;
    if (!devLoginAllowed(config)) return plainError(404, "Not found.");
    try {
      assertSameOrigin(req, config.appUrl);
    } catch (err) {
      if (err instanceof CsrfError) return plainError(403, "Cross-origin request refused.");
      throw err;
    }
    const form = await req.formData().catch(() => null);
    const next = safeNextPath(form?.get("next"));
    const now = clock(deps);
    const user = await upsertDevUser(db, now);
    await ensurePersonalOrg(db, user);
    const cookies = await startSession(deps, req, user.id, now);
    log.info("signed in with dev login", { userId: user.id });
    return redirectTo(appUrl(config, next), cookies, 303);
  };
}
