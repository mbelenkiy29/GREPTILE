import { mutation, query } from "./_generated/server";
import { scheduleSeatSync } from "./billing";
import { v } from "convex/values";
import { authenticated, authorize, service, audit } from "./auth";
import { rateLimit } from "./rateLimit";

export const login = mutation({
  args: {
    secret: v.string(),
    githubId: v.number(),
    login: v.string(),
    avatar: v.string(),
  },
  handler: async (ctx, args) => {
    service(args.secret);
    const user = await ctx.db
      .query("users")
      .withIndex("by_github", (q) => q.eq("githubId", args.githubId))
      .unique();
    if (user) {
      await ctx.db.patch(user._id, { login: args.login, avatar: args.avatar });
      return user._id;
    }
    return ctx.db.insert("users", {
      githubId: args.githubId,
      login: args.login,
      avatar: args.avatar,
      createdAt: Date.now(),
    });
  },
});
export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await authenticated(ctx, token);
    const members = await ctx.db
      .query("organizationMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const organizations = await Promise.all(
      members.map(async (m) => ({
        ...(await ctx.db.get(m.organizationId)),
        role: m.role,
      })),
    );
    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_login", (q) =>
        q.eq("githubLogin", user.login.toLowerCase()),
      )
      .collect();
    return {
      user,
      organizations,
      invitations: (await Promise.all(invitations.filter((i) => i.expiresAt > Date.now()).map(async i => {
        const organization = await ctx.db.get(i.organizationId);
        return organization ? {...i, workspaceName:organization.name} : null;
      }))).filter(i => i !== null),
    };
  },
});
export const createOrganization = mutation({
  args: { token: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const user = await authenticated(ctx, args.token);
    await rateLimit(ctx, `workspace:${user._id}`, 5, 3600000);
    if (!args.name.trim() || args.name.length > 100)
      throw new Error("Workspace name must be 1–100 characters");
    const organizationId = await ctx.db.insert("organizations", {
      name: args.name.trim(),
      createdAt: Date.now(),
    });
    await ctx.db.insert("organizationMembers", {
      organizationId,
      userId: user._id,
      role: "owner",
    });
    return organizationId;
  },
});
export const invite = mutation({
  args: {
    token: v.string(),
    organizationId: v.id("organizations"),
    githubLogin: v.string(),
    role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")),
  },
  handler: async (ctx, args) => {
    const {user}=await authorize(ctx, args.token, args.organizationId, true);
    if (!/^[a-zA-Z0-9-]{1,39}$/.test(args.githubLogin))
      throw new Error("Enter a valid GitHub login");
    // Reissuing an invitation replaces its previous grant instead of leaving
    // a stale higher-role invitation available to accept later.
    const login = args.githubLogin.toLowerCase();
    const previous = await ctx.db.query("invitations").withIndex("by_login", q => q.eq("githubLogin", login)).collect();
    for (const invitation of previous)
      if (invitation.organizationId === args.organizationId) {
        await ctx.db.delete(invitation._id);
        await audit(ctx,args.organizationId,user._id,"invitation.replaced",invitation._id);
      }
    const id=await ctx.db.insert("invitations", {
      organizationId: args.organizationId,
      githubLogin: login,
      role: args.role,
      expiresAt: Date.now() + 7 * 86400000,
    });
    await audit(ctx,args.organizationId,user._id,"invitation.created",id);
    return id;
  },
});
export const invitations = query({
  args:{token:v.string(),organizationId:v.id("organizations")},
  handler:async(ctx,args)=>{
    await authorize(ctx,args.token,args.organizationId,true);
    return (await ctx.db.query("invitations").withIndex("by_org",q=>q.eq("organizationId",args.organizationId)).collect()).filter(i=>i.expiresAt>Date.now());
  },
});
export const revokeInvitation = mutation({
  args:{token:v.string(),invitationId:v.id("invitations")},
  handler:async(ctx,args)=>{
    const invitation=await ctx.db.get(args.invitationId);
    if(!invitation)throw new Error("Invitation unavailable");
    const {user}=await authorize(ctx,args.token,invitation.organizationId,true);
    await ctx.db.delete(invitation._id);
    await audit(ctx,invitation.organizationId,user._id,"invitation.revoked",invitation._id);
  },
});
export const acceptInvitation = mutation({
  args: { token: v.string(), invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    const user = await authenticated(ctx, args.token),
      invitation = await ctx.db.get(args.invitationId);
    if (
      !invitation ||
      invitation.githubLogin !== user.login.toLowerCase() ||
      invitation.expiresAt <= Date.now() ||
      !(await ctx.db.get(invitation.organizationId))
    )
      throw new Error("Invitation invalid or expired");
    const member = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q
          .eq("organizationId", invitation.organizationId)
          .eq("userId", user._id),
      )
      .unique();
    if (!member)
      await ctx.db.insert("organizationMembers", {
        organizationId: invitation.organizationId,
        userId: user._id,
        role: invitation.role,
      });
    await ctx.db.delete(invitation._id);
    await audit(ctx,invitation.organizationId,user._id,"invitation.accepted",invitation._id);
    await scheduleSeatSync(ctx, invitation.organizationId);
    return invitation.organizationId;
  },
});
