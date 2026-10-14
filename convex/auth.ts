import { jwtVerify } from "jose";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { sessionHash } from "../src/session-hash";

export async function authenticated(
  ctx: QueryCtx | MutationCtx,
  token: string,
) {
  return (await authenticatedSession(ctx, token)).user;
}
// The user and, for browser sessions, the session row (null for API-key and legacy tokens).
export async function authenticatedSession(ctx: QueryCtx | MutationCtx, token: string): Promise<{ user: Doc<"users">; session: Doc<"sessions"> | null }> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("SESSION_SECRET must be at least 32 characters");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: "openreview",
    audience: "openreview",
    algorithms: ["HS256"],
  });
  if (typeof payload.sub !== "string") throw new Error("Unauthorized");
  const user = await ctx.db.get(payload.sub as Id<"users">);
  if (!user) throw new Error("Unauthorized");
  // Server-side session check: tokens carrying a session ID need an active session row; tokens
  // without one (legacy cookies, API-key calls) are rejected if issued before the user's cutoff
  // (sign out everywhere, workspace removal).
  if (payload.sid === undefined && user.sessionsValidAfter && (payload.iat ?? 0) * 1000 < user.sessionsValidAfter) throw new Error("Unauthorized");
  let session: Doc<"sessions"> | null = null;
  if (payload.sid !== undefined) {
    if (typeof payload.sid !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(payload.sid)) throw new Error("Unauthorized");
    session = await ctx.db.query("sessions").withIndex("by_hash", (q) => q.eq("hash", sessionHash(payload.sid as string))).unique();
    if (!session || session.userId !== user._id || session.revokedAt || session.expiresAt <= Date.now()) throw new Error("Unauthorized");
  }
  return { user, session };
}
// SSO enforcement (M2): when a workspace enforces its SSO connection, browser sessions must have been
// started through it. Owners keep access (so a broken IdP cannot lock everyone out) and API-key calls,
// which carry no session, are governed by their keys.
export async function enforceSso(ctx: QueryCtx | MutationCtx, organizationId: Id<"organizations">, role: string, session: Doc<"sessions"> | null) {
  if (!session || role === "owner") return;
  const connection = (await ctx.db.query("ssoConnections").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).take(5)).find((c) => c.active && c.enforce);
  if (connection && session.ssoConnectionId !== connection._id) throw new Error("This workspace requires single sign-on. Sign in with your organization's SSO.");
}
export async function authorize(
  ctx: QueryCtx | MutationCtx,
  token: string,
  organizationId: Id<"organizations">,
  admin = false,
) {
  const { user, session } = await authenticatedSession(ctx, token);
  const access = await organizationAccess(ctx,user._id,organizationId,admin);
  await enforceSso(ctx, organizationId, access.member.role, session);
  return access;
}
export async function organizationAccess(ctx:QueryCtx|MutationCtx,userId:Id<"users">,organizationId:Id<"organizations">,admin=false){
  const user=await ctx.db.get(userId);
  if(!user)throw new Error("Unauthorized");
  const member = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_user", (q) =>
      q.eq("organizationId", organizationId).eq("userId", user._id),
    )
    .unique();
  if (!member || (admin && !["owner", "admin"].includes(member.role)))
    throw new Error("Forbidden");
  return { user, member };
}
export function service(secret: string) {
  if (!process.env.SERVICE_SECRET || process.env.SERVICE_SECRET !== secret)
    throw new Error("Unauthorized service");
}

export async function visibleRepositories(ctx: QueryCtx | MutationCtx, token: string, organizationId: Id<"organizations">, teamId?: Id<"teams">) {
  const identity = await authorize(ctx, token, organizationId);
  if(teamId){const team=await ctx.db.get(teamId),member=await ctx.db.query("teamMembers").withIndex("by_team_user",q=>q.eq("teamId",teamId).eq("userId",identity.user._id)).unique();if(!team||team.organizationId!==organizationId||!member&&!["owner","admin"].includes(identity.member.role))throw new Error("Team not accessible");}
  const repos = (await ctx.db.query("repositories").withIndex("by_org", q => q.eq("organizationId", organizationId)).collect()).filter(r=>!teamId||r.teamId===teamId);
  if (["owner", "admin"].includes(identity.member.role)) return repos;
  const allowed = await Promise.all(repos.map(async repo => !repo.teamId || Boolean(await ctx.db.query("teamMembers").withIndex("by_team_user", q => q.eq("teamId", repo.teamId!).eq("userId", identity.user._id)).unique())));
  return repos.filter((_, i) => allowed[i]);
}
export async function authorizeRepository(ctx: QueryCtx | MutationCtx, token: string, repositoryId: Id<"repositories">, write = false, admin = false) {
  const { user, session } = await authenticatedSession(ctx, token);
  const access = await repositoryAccess(ctx, user._id, repositoryId, write, admin);
  await enforceSso(ctx, access.repo.organizationId, access.member.role, session);
  return access;
}
export async function repositoryAccess(ctx: QueryCtx | MutationCtx, userId: Id<"users">, repositoryId: Id<"repositories">, write = false, admin = false) {
  const repo = await ctx.db.get(repositoryId); if (!repo) throw new Error("Repository not found");
  const user = await ctx.db.get(userId);
  const member = await ctx.db.query("organizationMembers").withIndex("by_org_user", q => q.eq("organizationId", repo.organizationId).eq("userId", userId)).unique();
  if (!user || !member || (admin && !["owner", "admin"].includes(member.role))) throw new Error("Forbidden");
  const identity = {user, member};
  if (write && identity.member.role === "viewer") throw new Error("Viewers cannot modify repositories");
  if (repo.teamId && !["owner", "admin"].includes(identity.member.role)) {
    const m = await ctx.db.query("teamMembers").withIndex("by_team_user", q => q.eq("teamId", repo.teamId!).eq("userId", identity.user._id)).unique();
    if (!m || (write && m.role === "viewer")) throw new Error("Team access denied");
  }
  return { ...identity, repo };
}
export async function audit(ctx: MutationCtx, organizationId: Id<"organizations">, userId: Id<"users"> | undefined, action: string, target: string) {
  await ctx.db.insert("auditEvents", { organizationId, userId, action, target, createdAt: Date.now() });
}
