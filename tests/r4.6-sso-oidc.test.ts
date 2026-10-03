import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { authorizeRequest, resolveOrgContext } from "@/lib/auth/request";
import { validateSessionToken } from "@/lib/auth/sessions";
import { isSealedSecret } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { listAudit } from "@/lib/data/audit";
import { authAccounts, memberships, ssoConnections, users } from "@/lib/db/schema";
import {
  createSsoConnection,
  listSsoConnections,
  lookupSsoConnection,
  parseSsoForm,
  setSsoEnforcement,
  SsoConfigError,
  type SsoConnectionRow,
} from "@/lib/sso/connections";
import { createOidcCallbackHandler, createSsoLookupHandler, createSsoStartHandler, type SsoHandlerDeps } from "@/lib/sso/handlers";
import { clearOidcCache, discover } from "@/lib/sso/oidc";
import { SSO_COOKIE } from "@/lib/sso/state";
import { NOW, setCookies, TEST_SECRET, testAuthConfig as config, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { CLIENT_ID, CLIENT_SECRET, fakeIdp, ISSUER, publicResolve, type FakeIdp } from "./helpers/idp";

let db: Db;
let idp: FakeIdp;

beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("APP_SECRET", TEST_SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "");
  clearOidcCache();
  idp = await fakeIdp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function setup(opts: { defaultRole?: "member" | "admin"; domains?: string } = {}) {
  const owner = await userWithOrg(db, { login: "owner", orgName: "Acme", githubToken: { token: "user-token-for-tests", expiresAt: null } });
  const input = parseSsoForm(
    form({
      protocol: "oidc",
      name: "Acme IdP",
      issuer: `${ISSUER}/.well-known/openid-configuration`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowedDomains: opts.domains ?? "acme.test",
      defaultRole: opts.defaultRole ?? "member",
    }),
  );
  const connection = await createSsoConnection(db, { orgId: owner.org.id, userId: owner.user.id, now: NOW }, input);
  return { owner, connection };
}

function deps(now: Date = NOW): () => SsoHandlerDeps {
  return () => ({ db, config, net: { fetch: idp.fetch, allowPrivate: false, resolve: publicResolve }, now: () => now });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Start → IdP → callback. `token` mints the ID token from the authorization request's nonce. */
async function flow(
  connection: SsoConnectionRow,
  opts: {
    token?: (nonce: string) => Promise<string>;
    state?: (s: string) => string;
    cookie?: string;
    site?: string;
    now?: Date;
    code?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.site) headers["sec-fetch-site"] = opts.site;
  const start = await createSsoStartHandler(deps(opts.now))(
    new Request(`${config.appUrl}/api/auth/sso/${connection.id}/start?next=${encodeURIComponent("/dashboard/repos")}`, { headers }),
    ctx(connection.id),
  );
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location")!);
  const nonce = authorize.searchParams.get("nonce")!;
  const state = authorize.searchParams.get("state")!;
  const ssoCookie = setCookies(start).get(SSO_COOKIE)!.value;
  idp.arm(() => (opts.token ?? ((n) => idp.mint({ nonce: n, email: "ada@acme.test", name: "Ada Lovelace" }, { now: NOW })))(nonce));
  const callbackUrl = `${config.appUrl}/api/auth/sso/${connection.id}/callback?code=${opts.code ?? "good-code"}&state=${encodeURIComponent(opts.state ? opts.state(state) : state)}`;
  const cookie = [`${SSO_COOKIE}=${encodeURIComponent(ssoCookie)}`, ...(opts.cookie ? [opts.cookie] : [])].join("; ");
  const res = await createOidcCallbackHandler(deps(opts.now))(new Request(callbackUrl, { headers: { cookie } }), ctx(connection.id));
  return { start, authorize, res, location: new URL(res.headers.get("location")!), session: setCookies(res).get(SESSION_COOKIE)?.value };
}

describe("OIDC single sign-on", () => {
  test("R4.6 OIDC sign-in verifies the ID token, provisions the user just in time with the default role, and starts an SSO session", async () => {
    const { owner, connection } = await setup({ defaultRole: "admin" });
    const stored = (await db.select().from(ssoConnections).where(eq(ssoConnections.id, connection.id)))[0]!;
    expect(isSealedSecret(stored.clientSecretEnc!)).toBe(true);
    expect(stored.clientSecretEnc).not.toContain(CLIENT_SECRET);
    expect(stored.issuer).toBe(ISSUER);
    expect((await listSsoConnections(db, owner.org.id))[0]).not.toHaveProperty("clientSecretEnc");

    const { authorize, res, location, session } = await flow(connection);
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${config.appUrl}/api/auth/sso/${connection.id}/callback`);
    expect(res.status).toBe(303);
    expect(location.pathname).toBe("/dashboard/repos");
    // The token request authenticated with client_secret_basic and sent the PKCE verifier.
    const tokenReq = idp.requests.find((r) => r.url.endsWith("/token"))!;
    expect(tokenReq.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(new URLSearchParams(tokenReq.body!).get("code_verifier")).toBeTruthy();

    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.provider, "oidc"));
    expect(account!.providerAccountId).toBe(`${ISSUER}|idp-user-1`);
    expect(account!.email).toBe("ada@acme.test");
    const [user] = await db.select().from(users).where(eq(users.id, account!.userId));
    expect(user!.name).toBe("Ada Lovelace");
    // IdP-asserted addresses are not trusted outside the org: the user's own email stays empty.
    expect(user!.email).toBeNull();
    const [member] = await db.select().from(memberships).where(and(eq(memberships.orgId, owner.org.id), eq(memberships.userId, user!.id)));
    expect(member!.role).toBe("admin");

    const active = await validateSessionToken(db, session, { now: NOW, ttlDays: 30 });
    expect(active!.activeOrgId).toBe(owner.org.id);
    expect(active!.ssoOrgIds).toEqual([owner.org.id]);
    expect((await listAudit(db, owner.org.id, { action: "sso.signed_in" }))[0]!.metadata).toMatchObject({ email: "ada@acme.test", newUser: true, joined: true, role: "admin" });

    // Signing in again reuses the same user and membership.
    await flow(connection);
    expect(await db.select().from(authAccounts).where(eq(authAccounts.provider, "oidc"))).toHaveLength(1);
  });

  test("R4.6 OIDC rejects a bad state, nonce, audience, signature, expired token, unverified email, and a disallowed domain", async () => {
    const { connection } = await setup();
    const now = Math.floor(NOW.getTime() / 1000);
    const cases: [string, Parameters<typeof flow>[1], string][] = [
      ["state", { state: (s) => `${s}x` }, "sso_invalid_state"],
      ["nonce", { token: () => idp.mint({ nonce: "not-the-nonce", email: "ada@acme.test" }, { now: NOW }) }, "sso_invalid_response"],
      ["audience", { token: (n) => idp.mint({ nonce: n, email: "ada@acme.test", aud: "another-client" }, { now: NOW }) }, "sso_invalid_response"],
      ["issuer", { token: (n) => idp.mint({ nonce: n, email: "ada@acme.test", iss: "https://evil.example" }, { now: NOW }) }, "sso_invalid_response"],
      ["signature", { token: (n) => idp.mint({ nonce: n, email: "ada@acme.test" }, { now: NOW, key: "other" }) }, "sso_invalid_response"],
      ["expired", { token: (n) => idp.mint({ nonce: n, email: "ada@acme.test", iat: now - 3600, exp: now - 600 }, { now: NOW }) }, "sso_invalid_response"],
      ["unverified", { token: (n) => idp.mint({ nonce: n, email: "ada@acme.test", email_verified: false }, { now: NOW }) }, "sso_email_unverified"],
      ["domain", { token: (n) => idp.mint({ nonce: n, email: "mallory@evil.test" }, { now: NOW }) }, "sso_domain_not_allowed"],
      ["code", { code: "bad-code" }, "sso_idp_error"],
    ];
    for (const [name, opts, code] of cases) {
      const { location, session } = await flow(connection, opts);
      expect(location.pathname, name).toBe("/sign-in");
      expect(location.searchParams.get("error"), name).toBe(code);
      expect(session, name).toBeUndefined();
    }
    expect(await db.select().from(authAccounts).where(eq(authAccounts.provider, "oidc"))).toHaveLength(0);
  });

  test("R4.6 SSO enforcement blocks a GitHub-only session until it signs in through the org's connection", async () => {
    const { owner, connection } = await setup();
    // Requiring SSO needs the owner's own session to have signed in through it first.
    await expect(setSsoEnforcement(db, { orgId: owner.org.id, userId: owner.user.id, actorHasSso: false }, connection.id, true)).rejects.toBeInstanceOf(SsoConfigError);
    await setSsoEnforcement(db, { orgId: owner.org.id, userId: owner.user.id, actorHasSso: true }, connection.id, true);

    // The owner's existing (GitHub) session no longer works in the org...
    const before = await validateSessionToken(db, owner.token, { now: NOW, ttlDays: 30 });
    const resolution = await resolveOrgContext(db, before);
    expect(resolution).toMatchObject({ status: "sso_required", orgId: owner.org.id, connectionId: connection.id });
    const denied = await authorizeRequest({ db, clock: { now: NOW, ttlDays: 30 } }, new Request(`${config.appUrl}/api/x`, { headers: { cookie: owner.cookie } }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.response.status).toBe(403);
      expect(await denied.response.json()).toMatchObject({ error: "sso_required", signIn: `/api/auth/sso/${connection.id}/start` });
    }

    // ...until it signs in through SSO from the app: the identity links to the same user.
    const { session } = await flow(connection, { cookie: owner.cookie, site: "same-origin" });
    const after = await validateSessionToken(db, session, { now: NOW, ttlDays: 30 });
    expect(after!.userId).toBe(owner.user.id);
    expect((await resolveOrgContext(db, after)).status).toBe("ok");

    // The linked identity alone is not a way into the GitHub account: a fresh SSO sign-in is refused.
    const fresh = await flow(connection);
    expect(fresh.location.searchParams.get("error")).toBe("sso_use_primary_sign_in");

    // A sign-in started from another site never links to the visitor's account.
    const other = await userWithOrg(db, { login: "visitor" });
    clearOidcCache();
    const crossSite = await flow(connection, { cookie: other.cookie, site: "cross-site", token: (n) => idp.mint({ nonce: n, email: "eve@acme.test", sub: "idp-user-2" }, { now: NOW }) });
    const crossUser = await validateSessionToken(db, crossSite.session, { now: NOW, ttlDays: 30 });
    expect(crossUser!.userId).not.toBe(other.user.id);
  });

  test("R4.6 SSO lookup finds a connection by email domain or org slug, and refuses ambiguous domains", async () => {
    const { owner, connection } = await setup({ domains: "acme.test, acme.dev" });
    expect(await lookupSsoConnection(db, "ADA@acme.dev")).toMatchObject({ status: "found", connection: { id: connection.id } });
    expect(await lookupSsoConnection(db, owner.org.slug)).toMatchObject({ status: "found", connection: { id: connection.id } });
    expect(await lookupSsoConnection(db, "x@nowhere.test")).toEqual({ status: "not_found" });

    const lookup = createSsoLookupHandler(deps());
    const res = await lookup(
      new Request(`${config.appUrl}/api/auth/sso`, { method: "POST", headers: { origin: config.appUrl }, body: form({ identifier: "ada@acme.test", next: "/dashboard/rules" }) }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${config.appUrl}/api/auth/sso/${connection.id}/start?next=%2Fdashboard%2Frules&login_hint=ada%40acme.test`);
    const crossOrigin = await lookup(new Request(`${config.appUrl}/api/auth/sso`, { method: "POST", headers: { origin: "https://evil.example" }, body: form({ identifier: "ada@acme.test" }) }));
    expect(crossOrigin.status).toBe(403);

    const second = await userWithOrg(db, { login: "rival", orgName: "Rival" });
    await createSsoConnection(db, { orgId: second.org.id, userId: second.user.id }, { ...parseSsoForm(form({ protocol: "oidc", name: "R", issuer: "https://idp.rival.test", clientId: "c", clientSecret: "s", allowedDomains: "acme.test", defaultRole: "member" })) });
    expect(await lookupSsoConnection(db, "ada@acme.test")).toEqual({ status: "ambiguous" });
  });

  test("R4.6 SSO refuses private-network issuers unless SSO_ALLOW_PRIVATE_ISSUERS is set", async () => {
    const privateResolve = async () => ["10.0.0.5"];
    await expect(discover(ISSUER, { fetch: idp.fetch, allowPrivate: false, resolve: privateResolve })).rejects.toMatchObject({ code: "sso_misconfigured" });
    await expect(discover("http://idp.internal", { fetch: idp.fetch, allowPrivate: false })).rejects.toMatchObject({ code: "sso_misconfigured" });
    clearOidcCache();
    expect((await discover(ISSUER, { fetch: idp.fetch, allowPrivate: true, resolve: privateResolve })).issuer).toBe(ISSUER);
    // A discovery document naming a different issuer is refused.
    clearOidcCache();
    const liar = await fakeIdp({ discoveryIssuer: "https://other.example" });
    await expect(discover(ISSUER, { fetch: liar.fetch, allowPrivate: false, resolve: publicResolve })).rejects.toMatchObject({ code: "sso_misconfigured" });
  });
});
