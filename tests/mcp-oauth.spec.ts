import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash, randomBytes } from "node:crypto";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// The OAuth routes, consent actions and MCP endpoint run for real against convex-test. Next's request
// scope (cookies, redirect) and the client-metadata network fetch are replaced by fakes.
const holder = vi.hoisted(() => ({ t: undefined as unknown, jar: new Map<string, string>(), session: "", metadata: new Map<string, unknown>(), fetched: [] as string[] }));
class Redirect extends Error { constructor(readonly url: string) { super("redirect " + url); } }
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => holder.jar.has(name) ? { value: holder.jar.get(name) } : undefined, set: (name: string, value: string) => { holder.jar.set(name, value); }, delete: (o: string | { name: string }) => { holder.jar.delete(typeof o === "string" ? o : o.name); } }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Redirect(url); } }));
vi.mock("../src/server", () => ({
  backend: () => { type Call = (ref: unknown, args: unknown) => Promise<unknown>; const t = holder.t as { query: Call; mutation: Call; action: Call }; return { query: (r: unknown, a: unknown) => t.query(r, a), mutation: (r: unknown, a: unknown) => t.mutation(r, a), action: (r: unknown, a: unknown) => t.action(r, a) }; },
  signSession: (userId: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode("oauth-session-secret-at-least-32-characters")),
  seal: async (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url"),
  unseal: async (token: string) => JSON.parse(Buffer.from(token, "base64url").toString()),
  cookieOptions: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
  current: async () => ({ token: holder.session, ...(await (holder.t as { query: (r: unknown, a: unknown) => Promise<object> }).query((await import("../convex/_generated/api")).api.users.me, { token: holder.session })) }),
}));
vi.mock("../src/oauth-server", async (original) => ({ ...(await original<typeof import("../src/oauth-server")>()), safeMetadataFetch: async (url: URL) => { holder.fetched.push(url.toString()); const doc = holder.metadata.get(url.toString()); return doc ? { status: 200, contentType: "application/json", body: JSON.stringify(doc) } : { status: 404, contentType: "text/plain", body: "" }; } }));
import { GET as protectedResource } from "../app/api/oauth/metadata/protected-resource/route";
import { GET as authorizationServer } from "../app/api/oauth/metadata/authorization-server/route";
import { GET as authorize } from "../app/oauth/authorize/route";
import { POST as token } from "../app/api/oauth/token/route";
import { POST as register } from "../app/api/oauth/register/route";
import { POST as revokeRoute } from "../app/api/oauth/revoke/route";
import { POST as mcp } from "../app/api/mcp/route";
import { GET as repositoriesRoute } from "../app/api/repositories/route";
import { approveAuthorization, denyAuthorization } from "../app/oauth/consent/actions";

const modules = import.meta.glob("../convex/**/*.ts");
const base = "https://review.example.com", resource = `${base}/api/mcp`;
beforeEach(() => { process.env.SESSION_SECRET = "oauth-session-secret-at-least-32-characters"; process.env.SERVICE_SECRET = "oauth-service-secret"; process.env.APP_URL = base; holder.jar.clear(); holder.metadata.clear(); holder.fetched.length = 0; });
afterEach(() => { vi.restoreAllMocks(); delete process.env.APP_URL; });
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
const authorizeUrl = (params: Record<string, string>) => `${base}/oauth/authorize?${new URLSearchParams(params)}`;
const rpc = (bearer: string | undefined, body: unknown) => mcp(new Request(resource, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: "Bearer " + bearer } : {}) }, body: JSON.stringify(body) }));
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-test", version: "1" } } };
const call = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
const form = (params: Record<string, string>) => new Request(`${base}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });

test("MCP OAuth: discovery, client metadata documents, consent, PKCE code exchange, audience-bound tokens, scope challenge, rotation and revocation", async () => {
  const t = convexTest(schema, modules); holder.t = t;
  const login = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: "oauth-service-secret", githubId, login: "u" + githubId, avatar: "" }); return { id, token: await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)) }; };
  const alice = await login(81), viewer = await login(82), mallory = await login(83);
  const org = await t.mutation(api.users.createOrganization, { token: alice.token, name: "Acme" });
  const rival = await t.mutation(api.users.createOrganization, { token: mallory.token, name: "Rival" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: org, userId: viewer.id, role: "viewer" }));
  await t.mutation(api.repositories.connect, { token: alice.token, secret: "oauth-service-secret", organizationId: org, installationId: 81, account: "acme", accountId: 1, repositories: [{ id: 8101, fullName: "acme/shop", defaultBranch: "main" }] });
  await t.mutation(api.repositories.connect, { token: mallory.token, secret: "oauth-service-secret", organizationId: rival, installationId: 83, account: "rival", accountId: 3, repositories: [{ id: 8301, fullName: "rival/app", defaultBranch: "main" }] });

  // 1. Discovery: the unauthenticated MCP request points at the resource metadata, which names this server.
  const challenge = await rpc(undefined, initialize);
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp", scope="read"`);
  expect(await (await protectedResource(new Request(`${base}/.well-known/oauth-protected-resource/api/mcp`))).json()).toMatchObject({ resource, authorization_servers: [base] });
  const asMetadata = await (await authorizationServer(new Request(`${base}/.well-known/oauth-authorization-server`))).json();
  expect(asMetadata).toMatchObject({ issuer: base, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true });

  // 2. Client ID Metadata Document client; invalid requests never redirect to unverified URIs.
  const clientId = "https://client.example/oauth/mcp.json", redirectUri = "http://127.0.0.1:7777/callback";
  holder.metadata.set(clientId, { client_id: clientId, client_name: "Example Agent", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" });
  const p1 = pkce();
  const params = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: p1.challenge, code_challenge_method: "S256", scope: "read", state: "s-1", resource };
  const unknown = await authorize(new Request(authorizeUrl({ ...params, client_id: "https://client.example/other.json" })));
  expect([unknown.status, unknown.headers.get("location")]).toEqual([400, null]);
  const wrongRedirect = await authorize(new Request(authorizeUrl({ ...params, redirect_uri: "http://127.0.0.1:9999/evil" })));
  expect([wrongRedirect.status, wrongRedirect.headers.get("location")]).toEqual([400, null]);
  const noPkce = new URL((await authorize(new Request(authorizeUrl({ ...params, code_challenge_method: "plain" })))).headers.get("location")!);
  expect([noPkce.origin + noPkce.pathname, noPkce.searchParams.get("error"), noPkce.searchParams.get("state"), noPkce.searchParams.get("iss")]).toEqual([redirectUri, "invalid_request", "s-1", base]);
  const otherResource = new URL((await authorize(new Request(authorizeUrl({ ...params, resource: "https://other.example/mcp" })))).headers.get("location")!);
  expect(otherResource.searchParams.get("error")).toBe("invalid_target");
  const started = await authorize(new Request(authorizeUrl(params)));
  expect([started.status, started.headers.get("location")]).toEqual([302, `${base}/oauth/consent`]);
  expect(holder.fetched).toContain(clientId);

  // 3. Consent: the signed-in user approves one workspace; the client receives a code, state and issuer.
  holder.jar.set("openreview_session", alice.token); holder.session = alice.token;
  const approved = await approveAuthorization(Object.assign(new FormData(), {}) as FormData).catch((r) => r) as Redirect;
  expect(approved).toBeInstanceOf(Error); // organizationId missing → rejected by validation, no redirect
  await authorize(new Request(authorizeUrl(params)));
  const consent = new FormData(); consent.set("organizationId", org); consent.append("scopes", "read");
  const redirected = new URL(((await approveAuthorization(consent).catch((r) => r)) as Redirect).url);
  expect([redirected.origin + redirected.pathname, redirected.searchParams.get("state"), redirected.searchParams.get("iss")]).toEqual([redirectUri, "s-1", base]);
  const code1 = redirected.searchParams.get("code")!;
  expect(code1).toMatch(/^orx_/);
  expect(holder.jar.has("openreview_oauth_request")).toBe(false);

  // 4. Token exchange with the PKCE verifier; tokens are opaque, short-lived and never cached.
  const exchange = async (code: string, verifier: string) => token(form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource }));
  const badVerifier = await exchange(code1, pkce().verifier);
  expect([badVerifier.status, (await badVerifier.json()).error]).toEqual([400, "invalid_grant"]);
  // That attempt consumed the code; start again for a clean exchange.
  const p2 = pkce();
  await authorize(new Request(authorizeUrl({ ...params, code_challenge: p2.challenge })));
  const code2 = new URL(((await approveAuthorization(consent).catch((r) => r)) as Redirect).url).searchParams.get("code")!;
  const issued = await exchange(code2, p2.verifier);
  expect(issued.headers.get("cache-control")).toBe("no-store");
  const tokens = await issued.json();
  expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read" });
  expect([tokens.access_token, tokens.refresh_token].map((s: string) => s.slice(0, 4))).toEqual(["ora_", "orr_"]);

  // 5. The access token works at the MCP endpoint, scoped to Acme; read tokens get a step-up challenge for writes.
  expect((await rpc(tokens.access_token, initialize)).status).toBe(200);
  const listed = await (await rpc(tokens.access_token, call("list_repositories"))).json();
  expect(JSON.parse(listed.result.content[0].text).map((r: { fullName: string }) => r.fullName)).toEqual(["acme/shop"]);
  const write = await rpc(tokens.access_token, call("mark_finding_resolved", { findingId: "0".repeat(20) + "findings", comment: "done" }));
  expect(write.status).toBe(403);
  expect(write.headers.get("www-authenticate")).toMatch(/^Bearer error="insufficient_scope", resource_metadata="[^"]+", scope="write"/);
  // Audience binding: the MCP token is refused by the REST API.
  expect((await repositoriesRoute(new Request(`${base}/api/repositories`, { headers: { authorization: "Bearer " + tokens.access_token } }))).status).toBe(401);
  await expect(t.query(api.oauth.resolve, { secret: "oauth-service-secret", hash: createHash("sha256").update(tokens.access_token).digest("hex"), resource: "https://other.example/mcp" })).rejects.toThrow();

  // 6. Code replay revokes everything issued from that code.
  const replay = await exchange(code2, p2.verifier);
  expect((await replay.json()).error).toBe("invalid_grant");
  expect((await rpc(tokens.access_token, initialize)).status).toBe(401);

  // 7. Refresh tokens rotate; reusing an old one revokes the grant.
  const p3 = pkce();
  await authorize(new Request(authorizeUrl({ ...params, code_challenge: p3.challenge })));
  const fresh = await (await exchange(new URL(((await approveAuthorization(consent).catch((r) => r)) as Redirect).url).searchParams.get("code")!, p3.verifier)).json();
  const rotated = await (await token(form({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: clientId }))).json();
  expect(rotated.access_token).not.toBe(fresh.access_token);
  expect((await rpc(rotated.access_token, initialize)).status).toBe(200);
  expect((await (await token(form({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: clientId }))).json()).error).toBe("invalid_grant");
  expect((await rpc(rotated.access_token, initialize)).status).toBe(401);

  // 8. Dynamic registration (deprecated, kept for older clients), deny, and role-bounded consent.
  const registered = await register(new Request(`${base}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Legacy CLI", redirect_uris: ["http://localhost:4545/cb"] }) }));
  const legacy = await registered.json();
  expect([registered.status, legacy.client_id.slice(0, 4), legacy.token_endpoint_auth_method]).toEqual([201, "orc_", "none"]);
  expect((await register(new Request(`${base}/api/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) }))).status).toBe(400);
  const p4 = pkce();
  await authorize(new Request(authorizeUrl({ ...params, client_id: legacy.client_id, redirect_uri: "http://localhost:4545/cb", code_challenge: p4.challenge, scope: "read write" })));
  const denied = new URL(((await denyAuthorization().catch((r) => r)) as Redirect).url);
  expect([denied.searchParams.get("error"), denied.searchParams.get("iss")]).toEqual(["access_denied", base]);
  await expect(t.mutation(api.oauth.approve, { token: viewer.token, organizationId: org, clientId, clientName: "x", redirectUri, codeChallenge: p4.challenge, resource, scopes: ["read", "write"], hash: "a".repeat(64) })).rejects.toThrow(/exceeds your workspace role/);
  await expect(t.mutation(api.oauth.approve, { token: mallory.token, organizationId: org, clientId, clientName: "x", redirectUri, codeChallenge: p4.challenge, resource, scopes: ["read"], hash: "b".repeat(64) })).rejects.toThrow();

  // 9. Connections are listed and revocable from the dashboard and by the client (RFC 7009); API keys still work.
  const p5 = pkce();
  await authorize(new Request(authorizeUrl({ ...params, code_challenge: p5.challenge })));
  const last = await (await exchange(new URL(((await approveAuthorization(consent).catch((r) => r)) as Redirect).url).searchParams.get("code")!, p5.verifier)).json();
  const connections = await t.query(api.oauth.connections, { token: alice.token, organizationId: org });
  expect(connections.map((c) => [c.clientName, c.scopes, c.mine])).toEqual([["Example Agent", ["read"], true]]);
  expect(await t.query(api.oauth.connections, { token: mallory.token, organizationId: rival })).toEqual([]);
  await t.mutation(api.oauth.revoke, { token: alice.token, grantId: connections[0]._id as Id<"oauthGrants"> });
  expect((await rpc(last.access_token, initialize)).status).toBe(401);
  const p6 = pkce();
  await authorize(new Request(authorizeUrl({ ...params, code_challenge: p6.challenge })));
  const clientRevoked = await (await exchange(new URL(((await approveAuthorization(consent).catch((r) => r)) as Redirect).url).searchParams.get("code")!, p6.verifier)).json();
  expect((await revokeRoute(new Request(`${base}/api/oauth/revoke`, { method: "POST", body: new URLSearchParams({ token: clientRevoked.refresh_token, client_id: clientId }).toString() }))).status).toBe(200);
  expect((await rpc(clientRevoked.access_token, initialize)).status).toBe(401);
  const key = "or_oauth_test_key";
  await t.run((ctx) => ctx.db.insert("apiKeys", { organizationId: org, userId: alice.id, hash: createHash("sha256").update(key).digest("hex"), name: "k", prefix: key.slice(0, 11), createdAt: 0, revoked: false, scopes: ["read"] }));
  expect((await rpc(key, initialize)).status).toBe(200);
  const audits = (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  for (const action of ["oauth.authorized", "oauth.revoked", "oauth.revoked_by_client"]) expect(audits).toContain(action);
});
