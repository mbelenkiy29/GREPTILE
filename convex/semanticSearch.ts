"use node";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { inferenceBilling } from "./budgetModel";
import { Embeddings } from "../src/engine/embeddings";
import { redact } from "../src/engine/indexer";
import type { RankedHit } from "../src/engine/hybrid";

// Chunk-level vector search within one repository; empty when no embedding endpoint is configured.
export async function semanticHits(ctx: ActionCtx, repositoryId: Id<"repositories">, text: string, limit = 16): Promise<RankedHit[]> {
  const model = process.env.EMBEDDING_MODEL;
  if (!model || !text.trim()) return [];
  const embedder = new Embeddings(inferenceBilling(ctx)), started = Date.now();
  const embedded = await embedder.embed([redact(text).slice(0, 8000)]);
  await ctx.runMutation(internal.embeddings.usage, { repositoryId, tokens: embedded.tokens, estimatedCost: embedded.estimatedCost, durationMs: Date.now() - started });
  const matches = await ctx.vectorSearch("chunkEmbeddings", "by_vector", { vector: embedded.vectors[0], limit: Math.min(64, limit), filter: (q) => q.eq("scope", `${repositoryId}:${model}`) });
  const scores = new Map(matches.map((m) => [m._id, m._score]));
  return (await ctx.runQuery(internal.embeddings.chunkHits, { ids: matches.map((m) => m._id), repositoryId })).map((h) => ({ path: h.path, startLine: h.startLine, endLine: h.endLine, score: scores.get(h.id) ?? 0, reason: h.symbol }));
}
