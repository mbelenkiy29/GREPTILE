import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { decodeJwt } from "jose";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { audit, authenticated, authorize, service } from "./auth";
import { rateLimit } from "./rateLimit";
import { scheduleSeatSync } from "./billing";
import { emailAddress } from "../src/email";
import { sessionHash } from "../src/session-hash";

// Identities, sessions, email invitations and magic links.
// Linking rule: a new provider account joins an existing user only when BOTH sides carry the
// same email marked verified by its provider; otherwise it becomes a separate user. An
// unverified address therefore cannot take over anyone.
export const providers = ["github", "gitlab", "google", "email"] as const;
const provider = v.union(...providers.map((p) => v.literal(p)) as [ReturnType<typeof v.literal<"github">>, ReturnType<typeof v.literal<"gitlab">>, ReturnType<typeof v.literal<"google">>, ReturnType<typeof v.literal<"email">>]);
const sessionDays = 7;
const hex64 = /^[a-f0-9]{64}$/;
type Profile = { provider: (typeof providers)[number]; providerUserId: string; login: string; avatar: string; email?: string; emailVerified: boolean };
export async function linkIdentity(ctx: MutationCtx, p: Profile): Promise<Id<"users">> {
  const now = Date.now(), email = p.email ? emailAddress.safeParse(p.email).data : undefined;
  const existing = await ctx.db.query("identities").withIndex("by_provider_user", (q) => q.eq("provider", p.provider).eq("providerUserId", p.providerUserId)).unique();
  if (existing) {
    await ctx.db.patch(existing._id, { lastLoginAt: now, ...(email ? { email, emailVerified: p.emailVerified } : {}) });
    if (p.avatar) await ctx.db.patch(existing.userId, { avatar: p.avatar });
    if (p.provider === "github") await ctx.db.patch(existing.userId, { login: p.login });
    return existing.userId;
  }
  let userId: Id<"users"> | undefined;
  if (p.provider === "github") {
    const legacy = await ctx.db.query("users").withIndex("by_github", (q) => q.eq("githubId", Number(p.providerUserId))).unique();
    if (legacy) { userId = legacy._id; await ctx.db.patch(legacy._id, { login: p.login, ...(p.avatar ? { avatar: p.avatar } : {}) }); }
  }
  if (!userId && email && p.emailVerified) userId = (await ctx.db.query("identities").withIndex("by_email", (q) => q.eq("email", email)).filter((q) => q.eq(q.field("emailVerified"), true)).first())?.userId;
  if (!userId) userId = await ctx.db.insert("users", { login: p.login.slice(0, 100), avatar: p.avatar, ...(p.provider === "github" ? { githubId: Number(p.providerUserId) } : {}), createdAt: now });
  await ctx.db.insert("identities", { userId, provider: p.provider, providerUserId: p.providerUserId, ...(email ? { email } : {}), emailVerified: Boolean(email && p.emailVerified), createdAt: now, lastLoginAt: now });
  return userId;
}
async function startSession(ctx: MutationCtx, userId: Id<"users">, hash: string, providerName: string, userAgent?: string) {
  if (!hex64.test(hash)) throw new Error("Invalid session");
  await ctx.db.insert("sessions", { userId, hash, provider: providerName, ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}), createdAt: Date.now(), expiresAt: Date.now() + sessionDays * 86400000 });
}

// OAuth sign-in (GitHub, GitLab, Google): the web server verified the provider response.
// With `linkToken` (the caller is already signed in), the provider account is attached to that
// user explicitly; it may not already belong to someone else.
export const signIn = mutation({ args: { secret: v.string(), provider, providerUserId: v.string(), login: v.string(), avatar: v.string(), email: v.optional(v.string()), emailVerified: v.boolean(), sessionHash: v.string(), userAgent: v.optional(v.string()), linkToken: v.optional(v.string()) }, handler: async (ctx, a): Promise<Id<"users">> => {
  service(a.secret);
  if (a.provider === "email") throw new Error("Email sign-in uses magic links");
  if (!a.providerUserId || a.providerUserId.length > 200 || (a.provider === "github" && !/^\d{1,20}$/.test(a.providerUserId))) throw new Error("Invalid provider identity");
  let userId: Id<"users">;
  if (a.linkToken) {
    const current = await authenticated(ctx, a.linkToken);
    const existing = await ctx.db.query("identities").withIndex("by_provider_user", (q) => q.eq("provider", a.provider).eq("providerUserId", a.providerUserId)).unique();
    if (existing && existing.userId !== current._id) throw new Error("This account is already linked to another OpenReview user");
    if (!existing) { const email = a.email ? emailAddress.safeParse(a.email).data : undefined; await ctx.db.insert("identities", { userId: current._id, provider: a.provider, providerUserId: a.providerUserId, ...(email ? { email } : {}), emailVerified: Boolean(email && a.emailVerified), createdAt: Date.now(), lastLoginAt: Date.now() }); }
    userId = current._id;
  } else userId = await linkIdentity(ctx, { provider: a.provider, providerUserId: a.providerUserId, login: a.login, avatar: a.avatar, email: a.email, emailVerified: a.emailVerified });
  await startSession(ctx, userId, a.sessionHash, a.provider, a.userAgent);
  return userId;
} });

export const sessionValid = query({ args: { token: v.string() }, handler: async (ctx, a) => { try { await authenticated(ctx, a.token); return true; } catch { return false; } } });
const currentHash = (token: string) => { const sid = decodeJwt(token).sid; return typeof sid === "string" ? sessionHash(sid) : undefined; };
export const sessions = query({ args: { token: v.string() }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token), current = currentHash(a.token);
  const rows = (await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200)).filter((s) => !s.revokedAt && s.expiresAt > Date.now());
  const identities = await ctx.db.query("identities").withIndex("by_user", (q) => q.eq("userId", user._id)).take(20);
  return { sessions: rows.map((s) => ({ _id: s._id, provider: s.provider, userAgent: s.userAgent ?? null, createdAt: s.createdAt, expiresAt: s.expiresAt, current: s.hash === current })).sort((x, y) => y.createdAt - x.createdAt), identities: identities.map((i) => ({ provider: i.provider, email: i.email ?? null, emailVerified: i.emailVerified, lastLoginAt: i.lastLoginAt })) };
} });
export const revokeSession = mutation({ args: { token: v.string(), sessionId: v.id("sessions") }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token), session = await ctx.db.get(a.sessionId);
  if (!session || session.userId !== user._id) throw new Error("Session not found");
  if (!session.revokedAt) await ctx.db.patch(session._id, { revokedAt: Date.now() });
} });
export const signOut = mutation({ args: { token: v.string() }, handler: async (ctx, a) => {
  let hash: string | undefined;
  try { await authenticated(ctx, a.token); hash = currentHash(a.token); } catch { return; }
  const session = hash ? await ctx.db.query("sessions").withIndex("by_hash", (q) => q.eq("hash", hash)).unique() : null;
  if (session && !session.revokedAt) await ctx.db.patch(session._id, { revokedAt: Date.now() });
} });
export async function revokeAllSessions(ctx: MutationCtx, userId: Id<"users">) {
  const now = Date.now();
  await ctx.db.patch(userId, { sessionsValidAfter: now });
  for (const s of await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", userId)).take(500)) if (!s.revokedAt) await ctx.db.patch(s._id, { revokedAt: now });
}
export const signOutEverywhere = mutation({ args: { token: v.string() }, handler: async (ctx, a) => { const user = await authenticated(ctx, a.token); await revokeAllSessions(ctx, user._id); } });
// Removal from a workspace revokes the member's sessions and that workspace's API keys and bridges.
export async function revokeMemberAccess(ctx: MutationCtx, organizationId: Id<"organizations">, userId: Id<"users">) {
  await revokeAllSessions(ctx, userId);
  for (const key of await ctx.db.query("apiKeys").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).take(500)) if (key.userId === userId && !key.revoked) await ctx.db.patch(key._id, { revoked: true });
  for (const device of await ctx.db.query("bridgeDevices").withIndex("by_user", (q) => q.eq("userId", userId)).take(200)) if (device.organizationId === organizationId && !device.revoked) await ctx.db.patch(device._id, { revoked: true });
}

// Magic links (email sign-in): hashes only; single use; 15 minutes.
export const storeLoginToken = internalMutation({ args: { email: v.string(), tokenHash: v.string() }, handler: async (ctx, a) => {
  if (!hex64.test(a.tokenHash)) throw new Error("Invalid token");
  await rateLimit(ctx, `magic-link:${a.email}`, 3, 600000);
  await ctx.db.insert("loginTokens", { email: a.email, tokenHash: a.tokenHash, expiresAt: Date.now() + 15 * 60000, createdAt: Date.now() });
} });
export const consumeLoginToken = mutation({ args: { secret: v.string(), tokenHash: v.string(), sessionHash: v.string(), userAgent: v.optional(v.string()) }, handler: async (ctx, a): Promise<Id<"users"> | null> => {
  service(a.secret);
  if (!hex64.test(a.tokenHash)) return null;
  const token = await ctx.db.query("loginTokens").withIndex("by_token", (q) => q.eq("tokenHash", a.tokenHash)).unique();
  if (!token || token.usedAt || token.expiresAt <= Date.now()) return null;
  await ctx.db.patch(token._id, { usedAt: Date.now() });
  const userId = await linkIdentity(ctx, { provider: "email", providerUserId: token.email, login: token.email.split("@")[0], avatar: "", email: token.email, emailVerified: true });
  await startSession(ctx, userId, a.sessionHash, "email", a.userAgent);
  return userId;
} });

// Email invitations: admins invite an address; whoever opens the single-use link and signs in joins.
export const createEmailInvitation = internalMutation({ args: { token: v.string(), organizationId: v.id("organizations"), email: v.string(), role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")), tokenHash: v.string() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const email = emailAddress.parse(a.email);
  if (!hex64.test(a.tokenHash)) throw new Error("Invalid token");
  await rateLimit(ctx, `email-invite:${a.organizationId}`, 20, 3600000);
  const id = await ctx.db.insert("emailInvitations", { organizationId: a.organizationId, email, role: a.role, tokenHash: a.tokenHash, invitedBy: user._id, expiresAt: Date.now() + 7 * 86400000, createdAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, "invitation.email_created", id);
  return { id, workspace: (await ctx.db.get(a.organizationId))?.name ?? "an OpenReview workspace", inviter: user.login, email };
} });
export const emailInvitations = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  return (await ctx.db.query("emailInvitations").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).order("desc").take(100)).filter((i) => !i.acceptedAt && !i.revokedAt && i.expiresAt > Date.now()).map((i) => ({ _id: i._id, email: i.email, role: i.role, expiresAt: i.expiresAt }));
} });
export const revokeEmailInvitation = mutation({ args: { token: v.string(), invitationId: v.id("emailInvitations") }, handler: async (ctx, a) => {
  const invitation = await ctx.db.get(a.invitationId);
  if (!invitation) throw new Error("Invitation not found");
  const { user } = await authorize(ctx, a.token, invitation.organizationId, true);
  if (!invitation.revokedAt && !invitation.acceptedAt) await ctx.db.patch(invitation._id, { revokedAt: Date.now() });
  await audit(ctx, invitation.organizationId, user._id, "invitation.email_revoked", invitation._id);
} });
export const invitationPreview = query({ args: { tokenHash: v.string() }, handler: async (ctx, a) => {
  if (!hex64.test(a.tokenHash)) return null;
  const invitation = await ctx.db.query("emailInvitations").withIndex("by_token", (q) => q.eq("tokenHash", a.tokenHash)).unique();
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= Date.now()) return null;
  return { workspace: (await ctx.db.get(invitation.organizationId))?.name ?? "Workspace", role: invitation.role, expiresAt: invitation.expiresAt };
} });
export const acceptEmailInvitation = mutation({ args: { token: v.string(), tokenHash: v.string() }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token);
  if (!hex64.test(a.tokenHash)) throw new Error("Invitation is invalid or expired");
  const invitation = await ctx.db.query("emailInvitations").withIndex("by_token", (q) => q.eq("tokenHash", a.tokenHash)).unique();
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= Date.now()) throw new Error("Invitation is invalid or expired");
  const member = await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", invitation.organizationId).eq("userId", user._id)).unique();
  if (!member) await ctx.db.insert("organizationMembers", { organizationId: invitation.organizationId, userId: user._id, role: invitation.role });
  await ctx.db.patch(invitation._id, { acceptedAt: Date.now(), acceptedBy: user._id });
  await audit(ctx, invitation.organizationId, user._id, "invitation.email_accepted", invitation._id);
  await scheduleSeatSync(ctx, invitation.organizationId);
  return invitation.organizationId;
} });

// Migration: give every legacy GitHub user an identity row (idempotent, paginated).
export const backfillIdentities = internalMutation({ args: { cursor: v.optional(v.union(v.string(), v.null())) }, handler: async (ctx, a): Promise<{ created: number; done: boolean }> => {
  const page = await ctx.db.query("users").paginate({ numItems: 200, cursor: a.cursor ?? null });
  let created = 0;
  for (const user of page.page) {
    if (user.githubId === undefined) continue;
    const exists = await ctx.db.query("identities").withIndex("by_provider_user", (q) => q.eq("provider", "github").eq("providerUserId", String(user.githubId))).unique();
    if (!exists) { await ctx.db.insert("identities", { userId: user._id, provider: "github", providerUserId: String(user.githubId), emailVerified: false, createdAt: user.createdAt, lastLoginAt: user.createdAt }); created++; }
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0, internal.identity.backfillIdentities, { cursor: page.continueCursor });
  return { created, done: page.isDone };
} });
