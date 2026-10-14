import { jwtVerify } from "jose";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export async function authenticated(
  ctx: QueryCtx | MutationCtx,
  token: string,
) {
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
  return user;
}
export async function authorize(
  ctx: QueryCtx | MutationCtx,
  token: string,
  organizationId: Id<"organizations">,
  admin = false,
) {
  const user = await authenticated(ctx, token);
  return organizationAccess(ctx,user._id,organizationId,admin);
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
  const user = await authenticated(ctx, token);
  return repositoryAccess(ctx, user._id, repositoryId, write, admin);
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
