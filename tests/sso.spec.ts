import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sessionHash } from "../src/session-hash";

// DNS is faked: TXT records per name.
const dns = vi.hoisted(() => ({ records: new Map<string, string[][]>() }));
vi.mock("node:dns/promises", () => ({ resolveTxt: async (name: string) => { const r = dns.records.get(name); if (!r) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return r; } }));

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "sso-service";
beforeEach(() => { process.env.SERVICE_SECRET = secret; process.env.SESSION_SECRET = "sso-session-secret-at-least-32-characters"; dns.records.clear(); });
afterEach(() => vi.restoreAllMocks());
const jwt = (userId: string, sid?: string) => new SignJWT(sid ? { sid } : {}).setSubject(userId).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
const cert = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest\n-----END PUBLIC KEY-----";

test("SSO: domain proof, verified-email linking without takeover, JIT membership, replay refusal, enforcement and audit", async () => {
  const t = convexTest(schema, modules);
  // A browser session for a provider sign-in (token carries the session id).
  const browser = async (provider: "github" | "google", providerUserId: string, login: string, email?: string) => {
    const sid = randomBytes(32).toString("base64url");
    const userId = await t.mutation(api.identity.signIn, { secret, provider, providerUserId, login, avatar: "", ...(email ? { email, emailVerified: true } : {}), emailVerified: Boolean(email), sessionHash: sessionHash(sid) });
    return { id: userId, token: await jwt(userId, sid) };
  };
  const owner = await browser("github", "101", "owner"), carol = await browser("github", "102", "carol"), dana = await browser("google", "g-dana", "dana", "dana@acme.com");
  const org = await t.mutation(api.users.createOrganization, { token: owner.token, name: "Acme" });
  const rival = await t.mutation(api.users.createOrganization, { token: carol.token, name: "Rival" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: org, userId: carol.id, role: "member" }));
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: org, userId: dana.id, role: "member" }));

  // Admin-only configuration with validation; audited.
  await expect(t.mutation(api.sso.saveConnection, { token: carol.token, organizationId: org, protocol: "saml", name: "Okta", active: true, jitRole: "member", samlEntryPoint: "https://idp.acme.com/sso", samlIdpCert: cert })).rejects.toThrow();
  await expect(t.mutation(api.sso.saveConnection, { token: owner.token, organizationId: org, protocol: "saml", name: "Okta", active: true, jitRole: "member", samlEntryPoint: "http://idp.acme.com/sso", samlIdpCert: cert })).rejects.toThrow(/HTTPS sign-in URL/);
  await t.mutation(api.sso.saveConnection, { token: owner.token, organizationId: org, protocol: "saml", name: "Okta", active: true, jitRole: "member", samlEntryPoint: "https://idp.acme.com/sso", samlIdpCert: cert });
  const connection = (await t.query(api.sso.settings, { token: owner.token, organizationId: org })).connection!;
  await expect(t.mutation(api.sso.setEnforcement, { token: owner.token, organizationId: org, enforce: true })).rejects.toThrow(/verified domain/);

  // Domain proof by DNS TXT; a domain verified by one workspace cannot be claimed by another.
  const domainId = await t.mutation(api.sso.addDomain, { token: owner.token, organizationId: org, domain: "ACME.com" });
  const listed = (await t.query(api.sso.settings, { token: owner.token, organizationId: org })).domains[0];
  expect([listed.domain, listed.verified, listed.txtName]).toEqual(["acme.com", false, "_openreview-challenge.acme.com"]);
  expect(await t.action(api.ssoJobs.verifyDomain, { token: owner.token, domainId })).toBe(false);
  dns.records.set(listed.txtName, [[listed.txtValue]]);
  expect(await t.action(api.ssoJobs.verifyDomain, { token: owner.token, domainId })).toBe(true);
  await t.mutation(api.sso.saveConnection, { token: carol.token, organizationId: rival, protocol: "saml", name: "Rival IdP", active: true, jitRole: "none", samlEntryPoint: "https://idp.rival.com/sso", samlIdpCert: cert });
  await expect(t.mutation(api.sso.addDomain, { token: carol.token, organizationId: rival, domain: "acme.com" })).rejects.toThrow(/Another workspace already verified/);
  expect((await t.query(api.sso.forLogin, { secret, email: "someone@acme.com" }))?.id).toBe(connection._id);
  expect(await t.query(api.sso.forLogin, { secret, email: "someone@nowhere.com" })).toBeNull();

  // Sign-in: a verified-domain email links to the existing verified account (dana) instead of creating another.
  const login = (subject: string, email: string | undefined, extra: Record<string, unknown> = {}) => { const sid = randomBytes(32).toString("base64url"); return t.mutation(api.sso.signIn, { secret, connectionId: connection._id as Id<"ssoConnections">, subject, email, name: subject, sessionHash: sessionHash(sid), ...extra }).then(async (r) => ({ ...r, token: await jwt(r.userId, sid) })); };
  const danaSso = await login("okta-dana", "dana@acme.com", { assertionId: "_a1" });
  expect(danaSso.userId).toBe(dana.id);
  // Replay of the same assertion is refused.
  await expect(login("okta-dana", "dana@acme.com", { assertionId: "_a1" })).rejects.toThrow(/already used/);
  // An email outside the verified domains never links (no takeover), and gets no JIT membership.
  const outsider = await login("okta-x", "dana@other.com", { assertionId: "_a2" });
  expect(outsider.userId).not.toBe(dana.id);
  expect(outsider.member).toBe(false);
  // OIDC email_verified=false also prevents linking.
  expect((await login("oidc-x", "dana@acme.com", { emailVerifiedByIdp: false })).userId).not.toBe(dana.id);
  // JIT membership for a new person on the verified domain; the same subject maps to the same user.
  const erin = await login("okta-erin", "erin@acme.com", { assertionId: "_a3" });
  expect(erin.member).toBe(true);
  expect((await t.run((ctx) => ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", org).eq("userId", erin.userId)).unique()))?.role).toBe("member");
  expect((await login("okta-erin", "erin@acme.com", { assertionId: "_a4" })).userId).toBe(erin.userId);

  // Enforcement: members must use SSO sessions; owners and API-style tokens (no session) keep access.
  await t.mutation(api.sso.setEnforcement, { token: owner.token, organizationId: org, enforce: true });
  await expect(t.query(api.repositories.list, { token: carol.token, organizationId: org })).rejects.toThrow(/requires single sign-on/);
  await expect(t.query(api.repositories.list, { token: dana.token, organizationId: org })).rejects.toThrow(/requires single sign-on/);
  await expect(t.query(api.repositories.list, { token: danaSso.token, organizationId: org })).resolves.toEqual([]);
  await expect(t.query(api.repositories.list, { token: owner.token, organizationId: org })).resolves.toEqual([]);
  await expect(t.query(api.repositories.list, { token: await jwt(carol.id), organizationId: org })).resolves.toEqual([]);
  // Carol's other workspace is not affected by Acme's requirement.
  await expect(t.query(api.repositories.list, { token: carol.token, organizationId: rival })).resolves.toEqual([]);
  // Turning the connection off lifts the requirement, so nobody is locked out.
  await t.mutation(api.sso.saveConnection, { token: owner.token, organizationId: org, protocol: "saml", name: "Okta", active: false, jitRole: "member", samlEntryPoint: "https://idp.acme.com/sso", samlIdpCert: cert });
  await expect(t.query(api.repositories.list, { token: carol.token, organizationId: org })).resolves.toEqual([]);
  await expect(login("okta-erin", "erin@acme.com")).rejects.toThrow(/not active/);

  const audits = (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  for (const action of ["sso.connection_saved", "sso.domain_added", "sso.domain_verified", "sso.jit_member", "sso.enforced"]) expect(audits).toContain(action);
});
