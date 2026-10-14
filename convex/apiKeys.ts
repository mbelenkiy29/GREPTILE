import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authorize, service, audit } from "./auth";
export const create = mutation({
  args: {
    token: v.string(),
    organizationId: v.id("organizations"),
    name: v.string(),
    hash: v.string(),
    prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await authorize(
      ctx,
      args.token,
      args.organizationId,
      true,
    );
    if (!args.name.trim() || !/^[a-f0-9]{64}$/.test(args.hash))
      throw new Error("Invalid API key");
    const id=await ctx.db.insert("apiKeys", {
      organizationId: args.organizationId,
      userId: user._id,
      hash: args.hash,
      name: args.name.slice(0, 100),
      prefix: args.prefix.slice(0, 16),
      revoked: false,
      createdAt: Date.now(),
    });
    await audit(ctx,args.organizationId,user._id,"api_key.created",id);
    return id;
  },
});
export const list = query({
  args: { token: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    await authorize(ctx, args.token, args.organizationId, true);
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .take(100);
    return keys.map((k) => ({
      _id: k._id,
      name: k.name,
      prefix: k.prefix,
      revoked: k.revoked,
      createdAt: k.createdAt,
    }));
  },
});
export const revoke = mutation({
  args: { token: v.string(), keyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    if (!key) throw new Error("Key not found");
    const {user}=await authorize(ctx, args.token, key.organizationId, true);
    if(!key.revoked){
      await ctx.db.patch(key._id, { revoked: true });
      await audit(ctx,key.organizationId,user._id,"api_key.revoked",key._id);
    }
  },
});
export const resolve = query({
  args: { secret: v.string(), hash: v.string() },
  handler: async (ctx, args) => {
    service(args.secret);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .unique();
    if (!key || key.revoked) throw new Error("Invalid API key");
    const member = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", key.organizationId).eq("userId", key.userId),
      )
      .unique();
    if (!member)
      throw new Error("API key owner no longer has workspace access");
    return { userId: key.userId, organizationId: key.organizationId };
  },
});
