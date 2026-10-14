import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { audit, authenticated, authorize, service } from "./auth";
import { apiScopes } from "../src/api-scopes";

// OAuth state for the remote MCP endpoint. The Next.js routes generate secrets and hash them; only the
// hashes reach the database. Service functions take the backend secret; consent and connection
// management take the signed-in user's session and are audited.
const scopesValidator = v.array(v.union(...apiScopes.map((s) => v.literal(s))));
const roleAllows = (scope: string, role: string) => scope === "read" || (scope === "write" && role !== "viewer") || (scope === "admin" && ["owner", "admin"].includes(role));

export const client = query({ args: { secret: v.string(), clientId: v.string() }, handler: async (ctx, a) => {
  service(a.secret);
  return ctx.db.query("oauthClients").withIndex("by_client", (q) => q.eq("clientId", a.clientId)).unique();
} });
// Dynamic registration (kind registered) or a cached Client ID Metadata Document (kind metadata).
export const saveClient = mutation({ args: { secret: v.string(), clientId: v.string(), name: v.string(), redirectUris: v.array(v.string()), kind: v.union(v.literal("registered"), v.literal("metadata")) }, handler: async (ctx, a) => {
  service(a.secret);
  const existing = await ctx.db.query("oauthClients").withIndex("by_client", (q) => q.eq("clientId", a.clientId)).unique();
  const data = { name: a.name.slice(0, 100), redirectUris: a.redirectUris.slice(0, 10), kind: a.kind, ...(a.kind === "metadata" ? { fetchedAt: Date.now() } : {}) };
  if (existing) { if (existing.kind !== a.kind) throw new Error("Client id already in use"); await ctx.db.patch(existing._id, data); }
  else await ctx.db.insert("oauthClients", { clientId: a.clientId, ...data, createdAt: Date.now() });
} });

// Consent: the signed-in user approves a client for one workspace; scopes are bounded by their role.
export const approve = mutation({
  args: { token: v.string(), organizationId: v.id("organizations"), clientId: v.string(), clientName: v.string(), redirectUri: v.string(), codeChallenge: v.string(), resource: v.string(), scopes: scopesValidator, hash: v.string() },
  handler: async (ctx, a) => {
    const { user, member } = await authorize(ctx, a.token, a.organizationId);
    if (!a.scopes.length || a.scopes.some((s) => !roleAllows(s, member.role))) throw new Error("Requested access exceeds your workspace role");
    if (!/^[a-f0-9]{64}$/.test(a.hash) || !/^[A-Za-z0-9_-]{43}$/.test(a.codeChallenge)) throw new Error("Invalid authorization request");
    await ctx.db.insert("oauthCodes", { hash: a.hash, clientId: a.clientId, clientName: a.clientName.slice(0, 100), redirectUri: a.redirectUri, codeChallenge: a.codeChallenge, resource: a.resource, scopes: a.scopes, organizationId: a.organizationId, userId: user._id, expiresAt: Date.now() + 600_000, used: false });
    await audit(ctx, a.organizationId, user._id, "oauth.authorized", a.clientId.slice(0, 200));
  },
});

async function issue(ctx: MutationCtx, grantId: Id<"oauthGrants">, accessHash: string, refreshHash: string, accessSeconds: number, refreshDays: number) {
  await ctx.db.insert("oauthTokens", { hash: accessHash, grantId, kind: "access", expiresAt: Date.now() + accessSeconds * 1000 });
  await ctx.db.insert("oauthTokens", { hash: refreshHash, grantId, kind: "refresh", expiresAt: Date.now() + refreshDays * 86_400_000 });
}
async function revokeGrant(ctx: MutationCtx, grant: Doc<"oauthGrants">) {
  await ctx.db.patch(grant._id, { revoked: true });
  for (const t of await ctx.db.query("oauthTokens").withIndex("by_grant", (q) => q.eq("grantId", grant._id)).take(1000)) await ctx.db.delete(t._id);
}
type Grant = { error: string } | { scopes: string[] };
// Authorization code → tokens. Single use: replaying a code revokes everything issued from it.
export const exchange = mutation({
  args: { secret: v.string(), hash: v.string(), clientId: v.string(), redirectUri: v.string(), codeChallenge: v.string(), resource: v.optional(v.string()), accessHash: v.string(), refreshHash: v.string(), accessSeconds: v.number(), refreshDays: v.number() },
  handler: async (ctx, a): Promise<Grant> => {
    service(a.secret);
    const code = await ctx.db.query("oauthCodes").withIndex("by_hash", (q) => q.eq("hash", a.hash)).unique();
    if (!code) return { error: "invalid_grant" };
    if (code.used) { const grant = code.grantId ? await ctx.db.get(code.grantId) : null; if (grant) await revokeGrant(ctx, grant); return { error: "invalid_grant" }; }
    await ctx.db.patch(code._id, { used: true });
    if (code.expiresAt < Date.now() || code.clientId !== a.clientId || code.redirectUri !== a.redirectUri || code.codeChallenge !== a.codeChallenge || (a.resource !== undefined && a.resource !== code.resource)) return { error: "invalid_grant" };
    const member = await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", code.organizationId).eq("userId", code.userId)).unique();
    if (!member) return { error: "invalid_grant" };
    const grantId = await ctx.db.insert("oauthGrants", { organizationId: code.organizationId, userId: code.userId, clientId: code.clientId, clientName: code.clientName, scopes: code.scopes, resource: code.resource, revoked: false, createdAt: Date.now() });
    await ctx.db.patch(code._id, { grantId });
    await issue(ctx, grantId, a.accessHash, a.refreshHash, a.accessSeconds, a.refreshDays);
    return { scopes: code.scopes };
  },
});
// Refresh tokens rotate; presenting a used one again revokes the whole grant (token theft signal).
export const refresh = mutation({
  args: { secret: v.string(), hash: v.string(), clientId: v.string(), resource: v.optional(v.string()), accessHash: v.string(), refreshHash: v.string(), accessSeconds: v.number(), refreshDays: v.number() },
  handler: async (ctx, a): Promise<Grant> => {
    service(a.secret);
    const token = await ctx.db.query("oauthTokens").withIndex("by_hash", (q) => q.eq("hash", a.hash)).unique();
    if (!token || token.kind !== "refresh") return { error: "invalid_grant" };
    const grant = await ctx.db.get(token.grantId);
    if (!grant || grant.revoked) return { error: "invalid_grant" };
    if (token.used) { await revokeGrant(ctx, grant); return { error: "invalid_grant" }; }
    if (token.expiresAt < Date.now() || grant.clientId !== a.clientId || (a.resource !== undefined && a.resource !== grant.resource)) return { error: "invalid_grant" };
    await ctx.db.patch(token._id, { used: true });
    await ctx.db.patch(grant._id, { refreshedAt: Date.now() });
    await issue(ctx, grant._id, a.accessHash, a.refreshHash, a.accessSeconds, a.refreshDays);
    return { scopes: grant.scopes };
  },
});
// Resource server check: an unexpired access token of a live grant, issued for this resource, whose
// user is still a workspace member.
export const resolve = query({ args: { secret: v.string(), hash: v.string(), resource: v.string() }, handler: async (ctx, a) => {
  service(a.secret);
  const token = await ctx.db.query("oauthTokens").withIndex("by_hash", (q) => q.eq("hash", a.hash)).unique();
  if (!token || token.kind !== "access" || token.expiresAt < Date.now()) throw new Error("Invalid or expired access token");
  const grant = await ctx.db.get(token.grantId);
  if (!grant || grant.revoked || grant.resource !== a.resource) throw new Error("Invalid or expired access token");
  const member = await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", grant.organizationId).eq("userId", grant.userId)).unique();
  if (!member) throw new Error("Token owner no longer has workspace access");
  return { userId: grant.userId, organizationId: grant.organizationId, scopes: grant.scopes.filter((s) => roleAllows(s, member.role)) };
} });
// RFC 7009 revocation by the client (either token of a grant revokes the grant).
export const revokeToken = mutation({ args: { secret: v.string(), hash: v.string(), clientId: v.optional(v.string()) }, handler: async (ctx, a) => {
  service(a.secret);
  const token = await ctx.db.query("oauthTokens").withIndex("by_hash", (q) => q.eq("hash", a.hash)).unique();
  const grant = token ? await ctx.db.get(token.grantId) : null;
  if (grant && (!a.clientId || grant.clientId === a.clientId)) { await revokeGrant(ctx, grant); await audit(ctx, grant.organizationId, undefined, "oauth.revoked_by_client", grant._id); }
} });

// Dashboard: the signed-in user's connected MCP clients in a workspace (admins see everyone's).
export const connections = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user, member } = await authorize(ctx, a.token, a.organizationId);
  const admin = ["owner", "admin"].includes(member.role);
  const grants = admin
    ? await ctx.db.query("oauthGrants").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(200)
    : await ctx.db.query("oauthGrants").withIndex("by_org_user", (q) => q.eq("organizationId", a.organizationId).eq("userId", user._id)).take(200);
  const out = [];
  for (const g of grants.filter((g) => !g.revoked)) out.push({ _id: g._id, clientId: g.clientId, clientName: g.clientName, scopes: g.scopes, createdAt: g.createdAt, refreshedAt: g.refreshedAt, owner: (await ctx.db.get(g.userId))?.login ?? "unknown", mine: g.userId === user._id });
  return out.sort((x, y) => y.createdAt - x.createdAt);
} });
export const revoke = mutation({ args: { token: v.string(), grantId: v.id("oauthGrants") }, handler: async (ctx, a) => {
  const grant = await ctx.db.get(a.grantId);
  if (!grant) throw new Error("Connection not found");
  const user = await authenticated(ctx, a.token);
  if (grant.userId !== user._id) await authorize(ctx, a.token, grant.organizationId, true);
  else await authorize(ctx, a.token, grant.organizationId);
  await revokeGrant(ctx, grant);
  await audit(ctx, grant.organizationId, user._id, "oauth.revoked", grant._id);
} });
