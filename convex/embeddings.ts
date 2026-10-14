import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import {indexWriteAllowed,indexBatchMatches} from "./indexAuthority";
import { authorizeRepository } from "./auth";

// Current chunk-embedding state for a file: an unchanged blob embedded with the current model is
// skipped, which makes re-index backfills idempotent.
export const chunkState = internalQuery({
  args: { repositoryId: v.id("repositories"), path: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("chunkEmbeddings").withIndex("by_path", (q) => q.eq("repositoryId", args.repositoryId).eq("path", args.path)).take(500);
    if (!rows.length) return null;
    const shas = new Set(rows.map((r) => r.sha)), models = new Set(rows.map((r) => r.model));
    return { sha: shas.size === 1 ? rows[0].sha : null, model: models.size === 1 ? rows[0].model : null, chunks: rows.length };
  },
});
const chunk = v.object({ startLine: v.number(), endLine: v.number(), symbol: v.optional(v.string()), vector: v.array(v.float64()) });
export const saveChunks = internalMutation({
  args: { repositoryId: v.id("repositories"), jobId: v.id("indexJobs"), leaseId: v.optional(v.string()), path: v.string(), sha: v.string(), model: v.string(), chunks: v.array(chunk) },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.repositoryId !== args.repositoryId || !indexBatchMatches(job, args.leaseId) || !await indexWriteAllowed(ctx, repo, job)) return false;
    if (!repo || args.chunks.length > 64 || args.chunks.some((c) => c.vector.length !== 1536 || c.vector.some((n) => !Number.isFinite(n)) || c.endLine < c.startLine)) throw new Error("Invalid embedding");
    for (const old of await ctx.db.query("chunkEmbeddings").withIndex("by_path", (q) => q.eq("repositoryId", repo._id).eq("path", args.path)).take(500)) await ctx.db.delete(old._id);
    const legacy = await ctx.db.query("embeddings").withIndex("by_path", (q) => q.eq("repositoryId", repo._id).eq("path", args.path)).unique();
    if (legacy) await ctx.db.delete(legacy._id);
    for (const c of args.chunks)
      await ctx.db.insert("chunkEmbeddings", { organizationId: repo.organizationId, repositoryId: repo._id, path: args.path, sha: args.sha, model: args.model, scope: `${repo._id}:${args.model}`, startLine: c.startLine, endLine: c.endLine, ...(c.symbol ? { symbol: c.symbol.slice(0, 200) } : {}), vector: c.vector, updatedAt: Date.now() });
    return true;
  },
});
// Vector search returns IDs; resolve them to locations, keeping only this repository's rows.
export const chunkHits = internalQuery({
  args: { ids: v.array(v.id("chunkEmbeddings")), repositoryId: v.id("repositories") },
  handler: async (ctx, args) =>
    (await Promise.all(args.ids.slice(0, 64).map((id) => ctx.db.get(id))))
      .filter((d) => d?.repositoryId === args.repositoryId)
      .map((d) => ({ id: d!._id, path: d!.path, startLine: d!.startLine, endLine: d!.endLine, symbol: d!.symbol })),
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
// Dashboard status: whether semantic retrieval is configured for this deployment, and how much
// of the repository is embedded with the current model (bounded sample).
export const status = query({
  args: { token: v.string(), repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const { repo } = await authorizeRepository(ctx, args.token, args.repositoryId);
    const model = process.env.EMBEDDING_MODEL || undefined;
    if (!model) return { configured: false as const };
    const chunks = await ctx.db.query("chunkEmbeddings").withIndex("by_path", (q) => q.eq("repositoryId", repo._id)).take(1001);
    const current = chunks.filter((c) => c.model === model);
    return { configured: true as const, model, chunks: Math.min(current.length, 1000), more: current.length > 1000, files: new Set(current.map((c) => c.path)).size, stale: chunks.length - current.length };
  },
});
