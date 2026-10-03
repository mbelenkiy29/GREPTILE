/**
 * SSO route handlers (R4.6), as factories over injected dependencies so tests drive them with plain Requests:
 *
 * - POST /api/auth/sso                       → find the connection for an email or org slug (sign-in page form)
 * - GET  /api/auth/sso/[id]/start            → OIDC authorization request, or SAML AuthnRequest (HTTP-Redirect)
 * - GET  /api/auth/sso/[id]/callback         → OIDC: check state, exchange the code, verify the ID token, sign in
 * - POST /api/auth/saml/[id]/acs             → SAML: validate the response, sign in
 * - GET  /api/auth/saml/[id]/metadata        → SAML service provider metadata
 *
 * A successful sign-in provisions the user and membership (lib/sso/provision.ts) and issues a normal session that
 * records the org in `ssoOrgIds`, which satisfies that org's SSO enforcement.
 */
import type { Db } from "@/lib/db";
import type { RateLimiter } from "@/lib/api/rate-limit";
import { appUrl, type AuthConfig } from "@/lib/auth/config";
import { issueSessionCookies, readCookie, secureCookies, serializeCookie, SESSION_COOKIE } from "@/lib/auth/cookies";
import { plainError, redirectTo } from "@/lib/auth/http";
import { pkceChallenge, stateMatches } from "@/lib/auth/oauth";
import { safeNextPath, signInPath } from "@/lib/auth/redirect";
import { createSession, deleteSessionByToken, requestMetadata, sessionFromRequest } from "@/lib/auth/sessions";
import { decryptSecret } from "@/lib/crypto";
import { getMembership } from "@/lib/data/orgs";
import { errorMessage, log } from "@/lib/log";
import { checkRateLimit, clientAddress } from "@/lib/security/rate-limit";
import { assertSameOrigin, CsrfError } from "@/lib/security/csrf";
import { findSsoConnectionById, lookupSsoConnection, type SsoConnectionRow } from "./connections";
import { SsoError } from "./errors";
import type { SsoNetDeps } from "./net";
import { authorizationUrl, discover, exchangeCode, verifyIdToken } from "./oidc";
import { provisionSsoUser, type SsoIdentity } from "./provision";
import { samlAuthorizeUrl, samlServiceProviderMetadata, validateSamlResponse } from "./saml";
import { newSsoState, openSsoState, sealSsoState, SSO_COOKIE, SSO_COOKIE_PATH, SSO_STATE_MAX_AGE_S } from "./state";

export interface SsoHandlerDeps {
  db: Db;
  config: AuthConfig;
  net: SsoNetDeps;
  now?: () => Date;
  /** Public-endpoint rate limiting (R6.20); route files pass the shared Redis limiter. */
  rateLimit?: { limiter: RateLimiter; perMinute: number };
}

type Factory = () => SsoHandlerDeps;
type IdContext = { params: Promise<{ id: string }> };

const ssoLog = log.child({ component: "sso" });

export function oidcRedirectUri(config: Pick<AuthConfig, "appUrl">, connectionId: string): string {
  return appUrl(config, `/api/auth/sso/${connectionId}/callback`);
}

function stateCookie(config: AuthConfig, value: string, maxAge: number): string {
  return serializeCookie(SSO_COOKIE, value, { maxAge, path: SSO_COOKIE_PATH, httpOnly: true, secure: secureCookies(config), sameSite: "lax" });
}

function fail(config: AuthConfig, code: string, next?: string | null, cookies: string[] = []): Response {
  return redirectTo(appUrl(config, signInPath(next, code)), cookies, 303);
}

async function limited(deps: SsoHandlerDeps, bucket: string, req: Request, now: Date): Promise<Response | null> {
  if (!deps.rateLimit) return null;
  return checkRateLimit(bucket, clientAddress(req), { limiter: deps.rateLimit.limiter, limit: deps.rateLimit.perMinute, now });
}

/**
 * Starts a session for the SSO-authenticated user in the connection's org. A session of the same user on this
 * browser is replaced (keeping the orgs it already signed in to through SSO); anyone else's is ended.
 */
async function startSsoSession(deps: SsoHandlerDeps, req: Request, userId: string, orgId: string, now: Date): Promise<string[]> {
  const clock = { now, ttlDays: deps.config.sessionTtlDays };
  const existing = await sessionFromRequest(deps.db, req, clock);
  const carried = existing?.userId === userId ? existing.ssoOrgIds : [];
  if (existing) await deleteSessionByToken(deps.db, readCookie(req, SESSION_COOKIE));
  const { token } = await createSession(deps.db, {
    userId,
    activeOrgId: orgId,
    ssoOrgIds: [...new Set([...carried, orgId])],
    ...clock,
    ...requestMetadata(req),
  });
  return issueSessionCookies(deps.config, token);
}

async function finishSignIn(
  deps: SsoHandlerDeps,
  req: Request,
  connection: SsoConnectionRow,
  identity: SsoIdentity,
  input: { linkUserId: string | null; next: string; now: Date; extraCookies?: string[] },
): Promise<Response> {
  const { user, createdUser, joinedOrg } = await provisionSsoUser(deps.db, connection, identity, {
    linkUserId: input.linkUserId,
    now: input.now,
    ip: requestMetadata(req).ip,
  });
  const cookies = await startSsoSession(deps, req, user.id, connection.orgId, input.now);
  ssoLog.info("signed in with SSO", { orgId: connection.orgId, connectionId: connection.id, protocol: identity.protocol, userId: user.id, newUser: createdUser, joined: joinedOrg });
  return redirectTo(appUrl(deps.config, safeNextPath(input.next)), [...(input.extraCookies ?? []), ...cookies], 303);
}

/**
 * Who to link a new SSO identity to: the signed-in user, but only when they are already a member of the connection's
 * org (satisfying its SSO enforcement) and the request did not come from another site, so a page elsewhere cannot
 * link an identity of its choosing to a visitor's account.
 */
async function linkTarget(deps: SsoHandlerDeps, req: Request, connection: SsoConnectionRow, now: Date): Promise<string | null> {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return null;
  const session = await sessionFromRequest(deps.db, req, { now, ttlDays: deps.config.sessionTtlDays });
  if (!session) return null;
  return (await getMembership(deps.db, connection.orgId, session.userId)) ? session.userId : null;
}

function failure(config: AuthConfig, err: unknown, ctx: Record<string, unknown>, next?: string | null, cookies: string[] = []): Response {
  if (err instanceof SsoError) {
    ssoLog.warn("SSO sign-in failed", { ...ctx, code: err.code, error: errorMessage(err) });
    return fail(config, err.code, next, cookies);
  }
  ssoLog.error("SSO sign-in failed", { ...ctx, error: errorMessage(err) });
  return fail(config, "server_error", next, cookies);
}

/** POST /api/auth/sso (form: `identifier` = email or org slug, `next`). */
export function createSsoLookupHandler(factory: Factory) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const now = (deps.now ?? (() => new Date()))();
    const over = await limited(deps, "sso.lookup", req, now);
    if (over) return over;
    try {
      assertSameOrigin(req, deps.config.appUrl);
    } catch (err) {
      if (err instanceof CsrfError) return plainError(403, "Cross-origin request refused.");
      throw err;
    }
    const form = await req.formData().catch(() => null);
    const identifier = String(form?.get("identifier") ?? "").trim();
    const next = safeNextPath(form?.get("next"));
    const found = await lookupSsoConnection(deps.db, identifier);
    if (found.status === "ambiguous") return fail(deps.config, "sso_ambiguous", next);
    if (found.status === "not_found") return fail(deps.config, "sso_not_found", next);
    const params = new URLSearchParams({ next });
    if (identifier.includes("@")) params.set("login_hint", identifier.toLowerCase());
    return redirectTo(appUrl(deps.config, `/api/auth/sso/${found.connection.id}/start?${params.toString()}`), [], 303);
  };
}

/** GET /api/auth/sso/[id]/start?next=&login_hint= */
export function createSsoStartHandler(factory: Factory) {
  return async (req: Request, ctx: IdContext): Promise<Response> => {
    const deps = factory();
    const { config, db } = deps;
    const now = (deps.now ?? (() => new Date()))();
    const over = await limited(deps, "sso.start", req, now);
    if (over) return over;
    const { id } = await ctx.params;
    const params = new URL(req.url).searchParams;
    const next = safeNextPath(params.get("next"));
    const connection = await findSsoConnectionById(db, id);
    if (!connection) return fail(config, "sso_not_found", next);
    if (!connection.enabled) return fail(config, "sso_disabled", next);
    const linkUserId = await linkTarget(deps, req, connection, now);
    try {
      if (connection.protocol === "saml") {
        return redirectTo(await samlAuthorizeUrl(db, connection, { appUrl: config.appUrl, next, linkUserId, now: () => now }));
      }
      if (!connection.clientId) throw new SsoError("sso_misconfigured", "the OIDC connection has no client id");
      const discovery = await discover(connection.issuer, { ...deps.net, now: now.getTime() });
      const state = newSsoState({ connectionId: connection.id, next, linkUserId, now: now.getTime() });
      const hint = params.get("login_hint");
      const url = authorizationUrl(discovery, {
        clientId: connection.clientId,
        redirectUri: oidcRedirectUri(config, connection.id),
        state: state.state,
        nonce: state.nonce,
        codeChallenge: pkceChallenge(state.verifier),
        ...(hint && hint.length <= 320 ? { loginHint: hint } : {}),
      });
      return redirectTo(url, [stateCookie(config, sealSsoState(config.appSecret, state), SSO_STATE_MAX_AGE_S)]);
    } catch (err) {
      return failure(config, err, { orgId: connection.orgId, connectionId: connection.id, step: "start" }, next);
    }
  };
}

/** GET /api/auth/sso/[id]/callback?code=&state= (OIDC). */
export function createOidcCallbackHandler(factory: Factory) {
  return async (req: Request, ctx: IdContext): Promise<Response> => {
    const deps = factory();
    const { config, db } = deps;
    const now = (deps.now ?? (() => new Date()))();
    const over = await limited(deps, "sso.callback", req, now);
    if (over) return over;
    const { id } = await ctx.params;
    const params = new URL(req.url).searchParams;
    const clear = stateCookie(config, "", 0);
    const saved = openSsoState(config.appSecret, readCookie(req, SSO_COOKIE), now.getTime());
    const next = saved?.next;
    if (params.get("error")) return fail(config, "sso_idp_error", next, [clear]);
    if (!saved || saved.connectionId !== id || !stateMatches({ state: saved.state, verifier: saved.verifier, next: saved.next, issuedAt: saved.issuedAt }, params.get("state"))) {
      return fail(config, "sso_invalid_state", next, [clear]);
    }
    const code = params.get("code");
    if (!code || code.length > 2048) return fail(config, "sso_invalid_state", next, [clear]);
    const connection = await findSsoConnectionById(db, id);
    if (!connection || connection.protocol !== "oidc") return fail(config, "sso_not_found", next, [clear]);
    if (!connection.enabled) return fail(config, "sso_disabled", next, [clear]);
    const logCtx = { orgId: connection.orgId, connectionId: connection.id, step: "callback" };
    try {
      if (!connection.clientId || !connection.clientSecretEnc) throw new SsoError("sso_misconfigured", "the OIDC connection has no client credentials");
      const discovery = await discover(connection.issuer, { ...deps.net, now: now.getTime() });
      const idToken = await exchangeCode(
        discovery,
        { code, codeVerifier: saved.verifier, redirectUri: oidcRedirectUri(config, connection.id), clientId: connection.clientId, clientSecret: decryptSecret(connection.clientSecretEnc) },
        deps.net,
      );
      const identity = await verifyIdToken(idToken, { issuer: connection.issuer, discovery, clientId: connection.clientId, nonce: saved.nonce, now }, deps.net);
      return await finishSignIn(deps, req, connection, { protocol: "oidc", ...identity }, { linkUserId: saved.linkUserId, next: saved.next, now, extraCookies: [clear] });
    } catch (err) {
      return failure(config, err, logCtx, next, [clear]);
    }
  };
}

/** POST /api/auth/saml/[id]/acs (form: SAMLResponse). Cross-site by design: the IdP posts it. */
export function createSamlAcsHandler(factory: Factory) {
  return async (req: Request, ctx: IdContext): Promise<Response> => {
    const deps = factory();
    const { config, db } = deps;
    const now = (deps.now ?? (() => new Date()))();
    const over = await limited(deps, "sso.acs", req, now);
    if (over) return over;
    const { id } = await ctx.params;
    const connection = await findSsoConnectionById(db, id);
    if (!connection || connection.protocol !== "saml") return fail(config, "sso_not_found");
    if (!connection.enabled) return fail(config, "sso_disabled");
    const form = await req.formData().catch(() => null);
    const samlResponse = form?.get("SAMLResponse");
    try {
      if (typeof samlResponse !== "string") throw new SsoError("sso_invalid_response", "no SAMLResponse in the form");
      const result = await validateSamlResponse(db, connection, { appUrl: config.appUrl, samlResponse, now: () => now });
      return await finishSignIn(deps, req, connection, { protocol: "saml", subject: result.subject, email: result.email, name: result.name }, { linkUserId: result.linkUserId, next: result.next, now });
    } catch (err) {
      return failure(config, err, { orgId: connection.orgId, connectionId: connection.id, step: "acs" });
    }
  };
}

/** GET /api/auth/saml/[id]/metadata: the SP metadata XML to give the IdP. */
export function createSamlMetadataHandler(factory: () => Pick<SsoHandlerDeps, "db" | "config">) {
  return async (_req: Request, ctx: IdContext): Promise<Response> => {
    const { db, config } = factory();
    const { id } = await ctx.params;
    const connection = await findSsoConnectionById(db, id);
    if (!connection || connection.protocol !== "saml") return plainError(404, "Not found.");
    return new Response(samlServiceProviderMetadata(connection, config.appUrl), {
      headers: { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "no-store" },
    });
  };
}

