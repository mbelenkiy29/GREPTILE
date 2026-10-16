import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { audit, authorize, service } from "./auth";
import { linkIdentity } from "./identity";
import { scheduleSeatSync } from "./billing";
import { domainSchema, emailDomain, ssoEmailVerified, verificationName, verificationValue } from "../src/sso-domains";

// Per-workspace SSO (M2). Admin settings are audited; the login side is called by the web server with
// the backend secret after it validated the SAML assertion or OIDC ID token.
const connectionOf = (ctx: QueryCtx, organizationId: Id<"organizations">) => ctx.db.query("ssoConnections").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).first();
const verifiedDomains = async (ctx: QueryCtx, connectionId: Id<"ssoConnections">) => (await ctx.db.query("ssoDomains").withIndex("by_connection", (q) => q.eq("connectionId", connectionId)).take(50)).filter((d) => d.verifiedAt).map((d) => d.domain);
const httpsUrl = (value: string) => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && value.length <= 500; } catch { return false; } };
const pem = (value: string) => value.length <= 20_000 && /-----BEGIN (CERTIFICATE|PUBLIC KEY)-----[\s\S]+-----END (CERTIFICATE|PUBLIC KEY)-----/.test(value);

export const settings = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  const c = await connectionOf(ctx, a.organizationId);
  if (!c) return { connection: null, domains: [] };
  const domains = (await ctx.db.query("ssoDomains").withIndex("by_connection", (q) => q.eq("connectionId", c._id)).take(50)).map((d) => ({ _id: d._id, domain: d.domain, verified: Boolean(d.verifiedAt), txtName: verificationName(d.domain), txtValue: verificationValue(d.token) }));
  const { oidcClientSecret, ...visible } = c;
  return { connection: { ...visible, hasClientSecret: Boolean(oidcClientSecret) }, domains };
} });

export const saveConnection = mutation({
  args: { token: v.string(), organizationId: v.id("organizations"), protocol: v.union(v.literal("saml"), v.literal("oidc")), name: v.string(), active: v.boolean(), jitRole: v.union(v.literal("none"), v.literal("member"), v.literal("viewer")), samlEntryPoint: v.optional(v.string()), samlIdpCert: v.optional(v.string()), samlIdpIssuer: v.optional(v.string()), oidcIssuer: v.optional(v.string()), oidcClientId: v.optional(v.string()), oidcClientSecret: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const { user } = await authorize(ctx, a.token, a.organizationId, true);
    const existing = await connectionOf(ctx, a.organizationId);
    if (!a.name.trim() || a.name.length > 100) throw new Error("Name the connection (up to 100 characters)");
    if (a.protocol === "saml" && (!a.samlEntryPoint || !httpsUrl(a.samlEntryPoint) || !a.samlIdpCert || !pem(a.samlIdpCert) || (a.samlIdpIssuer !== undefined && a.samlIdpIssuer.length > 500))) throw new Error("SAML needs the IdP's HTTPS sign-in URL and its signing certificate (PEM)");
    const secret = a.oidcClientSecret ?? (existing?.protocol === "oidc" ? existing.oidcClientSecret : undefined);
    if (a.protocol === "oidc" && (!a.oidcIssuer || !httpsUrl(a.oidcIssuer) || !a.oidcClientId || a.oidcClientId.length > 300 || !secret || secret.split(".").length !== 3)) throw new Error("OIDC needs the HTTPS issuer, a client ID and a client secret");
    const data = {
      protocol: a.protocol, name: a.name.trim(), active: a.active, jitRole: a.jitRole === "none" ? undefined : a.jitRole,
      ...(a.protocol === "saml" ? { samlEntryPoint: a.samlEntryPoint, samlIdpCert: a.samlIdpCert!.trim(), samlIdpIssuer: a.samlIdpIssuer?.trim() || undefined, oidcIssuer: undefined, oidcClientId: undefined, oidcClientSecret: undefined }
        : { oidcIssuer: a.oidcIssuer!.replace(/\/+$/, ""), oidcClientId: a.oidcClientId, oidcClientSecret: secret, samlEntryPoint: undefined, samlIdpCert: undefined, samlIdpIssuer: undefined }),
      // Turning a connection off also turns enforcement off, so nobody is locked out.
      ...(!a.active ? { enforce: false } : {}),
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, data);
    else await ctx.db.insert("ssoConnections", { organizationId: a.organizationId, enforce: false, ...data, createdAt: Date.now() });
    await audit(ctx, a.organizationId, user._id, "sso.connection_saved", a.protocol);
  },
});
export const setEnforcement = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), enforce: v.boolean() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const c = await connectionOf(ctx, a.organizationId);
  if (!c) throw new Error("Set up SSO first");
  if (a.enforce && (!c.active || !(await verifiedDomains(ctx, c._id)).length)) throw new Error("Enforcement needs an active connection and at least one verified domain");
  await ctx.db.patch(c._id, { enforce: a.enforce, updatedAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, a.enforce ? "sso.enforced" : "sso.not_enforced", c._id);
} });
// Domain claims: a random token the admin publishes as a TXT record; verification happens in ssoJobs.
export const addDomain = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), domain: v.string() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const c = await connectionOf(ctx, a.organizationId);
  if (!c) throw new Error("Set up SSO first");
  const domain = domainSchema.parse(a.domain);
  const taken = await ctx.db.query("ssoDomains").withIndex("by_domain", (q) => q.eq("domain", domain)).take(20);
  if (taken.some((d) => d.verifiedAt && d.organizationId !== a.organizationId)) throw new Error("Another workspace already verified this domain");
  if (taken.some((d) => d.connectionId === c._id)) throw new Error("This domain is already added");
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  const id = await ctx.db.insert("ssoDomains", { organizationId: a.organizationId, connectionId: c._id, domain, token: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""), createdAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, "sso.domain_added", domain);
  return id;
} });
export const removeDomain = mutation({ args: { token: v.string(), domainId: v.id("ssoDomains") }, handler: async (ctx, a) => {
  const d = await ctx.db.get(a.domainId);
  if (!d) throw new Error("Domain not found");
  const { user } = await authorize(ctx, a.token, d.organizationId, true);
  await ctx.db.delete(d._id);
  const c = await ctx.db.get(d.connectionId);
  if (c?.enforce && !(await verifiedDomains(ctx, c._id)).length) await ctx.db.patch(c._id, { enforce: false, updatedAt: Date.now() });
  await audit(ctx, d.organizationId, user._id, "sso.domain_removed", d.domain);
} });
export const domainCheck = internalQuery({ args: { token: v.string(), domainId: v.id("ssoDomains") }, handler: async (ctx, a) => {
  const d = await ctx.db.get(a.domainId);
  if (!d) throw new Error("Domain not found");
  await authorize(ctx, a.token, d.organizationId, true);
  return { domain: d.domain, token: d.token, organizationId: d.organizationId };
} });
export const markVerified = internalMutation({ args: { domainId: v.id("ssoDomains") }, handler: async (ctx, a) => {
  const d = await ctx.db.get(a.domainId);
  if (!d) return false;
  const other = (await ctx.db.query("ssoDomains").withIndex("by_domain", (q) => q.eq("domain", d.domain)).take(20)).some((x) => x.verifiedAt && x.organizationId !== d.organizationId);
  if (other) return false;
  await ctx.db.patch(d._id, { verifiedAt: Date.now() });
  await audit(ctx, d.organizationId, undefined, "sso.domain_verified", d.domain);
  return true;
} });

// Login side (web server with the backend secret).
export const forLogin = query({ args: { secret: v.string(), email: v.optional(v.string()), connectionId: v.optional(v.string()) }, handler: async (ctx, a) => {
  service(a.secret);
  let connectionId = a.connectionId ? ctx.db.normalizeId("ssoConnections", a.connectionId) : null;
  if (!connectionId && a.email) {
    const domain = emailDomain(a.email);
    const verified = (await ctx.db.query("ssoDomains").withIndex("by_domain", (q) => q.eq("domain", domain)).take(20)).find((d) => d.verifiedAt);
    connectionId = verified?.connectionId ?? null;
  }
  const c = connectionId ? await ctx.db.get(connectionId) : null;
  if (!c || !c.active) return null;
  return { id: c._id, organizationId: c.organizationId, protocol: c.protocol, samlEntryPoint: c.samlEntryPoint, samlIdpCert: c.samlIdpCert, samlIdpIssuer: c.samlIdpIssuer, oidcIssuer: c.oidcIssuer, oidcClientId: c.oidcClientId, oidcClientSecret: c.oidcClientSecret };
} });
export const cacheSave = mutation({ args: { secret: v.string(), key: v.string(), value: v.string() }, handler: async (ctx, a) => {
  service(a.secret);
  if (a.key.length > 200 || a.value.length > 200) throw new Error("Invalid request id");
  await ctx.db.insert("ssoRequests", { key: a.key, value: a.value, expiresAt: Date.now() + 10 * 60_000 });
} });
export const cacheGet = query({ args: { secret: v.string(), key: v.string() }, handler: async (ctx, a) => {
  service(a.secret);
  const row = await ctx.db.query("ssoRequests").withIndex("by_key", (q) => q.eq("key", a.key)).first();
  return row && row.expiresAt > Date.now() ? row.value : null;
} });
export const cacheRemove = mutation({ args: { secret: v.string(), key: v.string() }, handler: async (ctx, a) => {
  service(a.secret);
  const row = await ctx.db.query("ssoRequests").withIndex("by_key", (q) => q.eq("key", a.key)).first();
  if (row) await ctx.db.delete(row._id);
  return row?.value ?? null;
} });

async function startSsoSession(ctx: MutationCtx, userId: Id<"users">, connectionId: Id<"ssoConnections">, hash: string, userAgent?: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid session");
  await ctx.db.insert("sessions", { userId, hash, provider: "sso", ssoConnectionId: connectionId, ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}), createdAt: Date.now(), expiresAt: Date.now() + 7 * 86_400_000 });
}
// Sign-in after the web server validated the assertion or ID token. The IdP email is trusted for
// account linking only on a domain this connection verified (and not marked unverified by OIDC).
export const signIn = mutation({
  args: { secret: v.string(), connectionId: v.id("ssoConnections"), subject: v.string(), email: v.optional(v.string()), emailVerifiedByIdp: v.optional(v.boolean()), name: v.string(), assertionId: v.optional(v.string()), assertionExpiresAt: v.optional(v.number()), sessionHash: v.string(), userAgent: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ userId: Id<"users">; organizationId: Id<"organizations">; member: boolean }> => {
    service(a.secret);
    const c = await ctx.db.get(a.connectionId);
    if (!c || !c.active) throw new Error("SSO connection is not active");
    if (!a.subject || a.subject.length > 300) throw new Error("Invalid subject");
    if (a.assertionId) {
      if (await ctx.db.query("ssoAssertions").withIndex("by_assertion", (q) => q.eq("connectionId", c._id).eq("assertionId", a.assertionId!)).first()) throw new Error("This SAML assertion was already used");
      await ctx.db.insert("ssoAssertions", { connectionId: c._id, assertionId: a.assertionId, expiresAt: Math.min(a.assertionExpiresAt ?? Date.now() + 600_000, Date.now() + 86_400_000) });
    }
    const emailVerified = ssoEmailVerified(a.email, await verifiedDomains(ctx, c._id), a.emailVerifiedByIdp);
    const userId = await linkIdentity(ctx, { provider: "sso", providerUserId: `${c._id}:${a.subject}`, login: (a.name || a.email?.split("@")[0] || "sso-user").slice(0, 100), avatar: "", email: a.email, emailVerified });
    let member = Boolean(await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", c.organizationId).eq("userId", userId)).unique());
    // Just-in-time membership: only for people whose email is on a verified domain.
    if (!member && c.jitRole && emailVerified) {
      await ctx.db.insert("organizationMembers", { organizationId: c.organizationId, userId, role: c.jitRole as "member" | "viewer" });
      await audit(ctx, c.organizationId, userId, "sso.jit_member", userId);
      await scheduleSeatSync(ctx, c.organizationId);
      member = true;
    }
    await startSsoSession(ctx, userId, c._id, a.sessionHash, a.userAgent);
    return { userId, organizationId: c.organizationId, member };
  },
});
