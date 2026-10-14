import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import {indexWriteAllowed,indexBatchMatches} from "./indexAuthority";
export const existing = internalQuery({
  args: { repositoryId: v.id("repositories"), path: v.string() },
  handler: (ctx, args) =>
    ctx.db
      .query("embeddings")
      .withIndex("by_path", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("path", args.path),
      )
      .unique(),
});
export const paths = internalQuery({
  args: {
    ids: v.array(v.id("embeddings")),
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs
      .filter((d) => d?.repositoryId === args.repositoryId)
      .map((d) => d!.path);
  },
});
export const save = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    jobId:v.id("indexJobs"),
    leaseId:v.optional(v.string()),
    path: v.string(),
    sha: v.string(),
    model: v.string(),
    vector: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    const job=await ctx.db.get(args.jobId);
    if(!job||!indexBatchMatches(job,args.leaseId)||!await indexWriteAllowed(ctx,repo,job))return;
    if (
      !repo ||
      args.vector.length !== 1536 ||
      args.vector.some((n) => !Number.isFinite(n))
    )
      throw new Error("Invalid embedding");
    const existing = await ctx.db
      .query("embeddings")
      .withIndex("by_path", (q) =>
        q.eq("repositoryId", repo._id).eq("path", args.path),
      )
      .unique();
    const record = {
      repositoryId:args.repositoryId,path:args.path,sha:args.sha,model:args.model,vector:args.vector,
      organizationId: repo.organizationId,
      scope: `${repo._id}:${args.model}`,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, record);
    else await ctx.db.insert("embeddings", record);
  },
});
export const usage = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    tokens: v.number(),
    estimatedCost: v.number(),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return;
    await ctx.db.insert("usageEvents", {
      organizationId: repo.organizationId,
      repositoryId: repo._id,
      kind: "embedding",
      inputTokens: args.tokens,
      outputTokens: 0,
      estimatedCost: args.estimatedCost,
      durationMs: args.durationMs,
      createdAt: Date.now(),
    });
  },
});
