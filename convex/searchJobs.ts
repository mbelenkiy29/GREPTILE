"use node";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { semanticHits } from "./semanticSearch";
import { hybridRank } from "../src/engine/hybrid";
import { redact } from "../src/engine/indexer";

export type SearchResult = { repositoryId: Id<"repositories">; repository: string; path: string; startLine: number; endLine: number; snippet: string; score: number; reason: string; revision: string };
// Hybrid code search (full-text + semantic when embeddings are configured) over indexed
// repositories the caller can see. Excerpts come from the stored index at `indexedSha`.
export const hybrid = action({ args: { token: v.string(), organizationId: v.id("organizations"), repositoryIds: v.optional(v.array(v.id("repositories"))), query: v.string(), limit: v.optional(v.number()) }, handler: async (ctx, a): Promise<SearchResult[]> => {
  const query = a.query.trim();
  if (query.length < 2 || query.length > 200) throw new Error("Search query must be 2 to 200 characters");
  const limit = Math.min(50, Math.max(1, Math.floor(a.limit ?? 20)));
  const visible: Doc<"repositories">[] = await ctx.runQuery(api.repositories.list, { token: a.token, organizationId: a.organizationId });
  const ids = a.repositoryIds ? [...new Set(a.repositoryIds)] : visible.filter((r) => r.enabled && r.indexedSha).map((r) => r._id).slice(0, 10);
  if (!ids.length || ids.length > 10) throw new Error("Search 1 to 10 indexed repositories");
  const repos = ids.map((id) => { const repo = visible.find((r) => r._id === id); if (!repo) throw new Error("Repository not accessible"); if (!repo.indexedSha) throw new Error(`${repo.fullName} has not been indexed yet`); return repo; });
  await ctx.runMutation(internal.searchData.limit, { key: `search:${a.organizationId}`, maximum: 60 });
  const results: SearchResult[] = [];
  for (const repo of repos) {
    const text = await ctx.runQuery(internal.agentTools.search, { repositoryId: repo._id, query });
    const vector = await semanticHits(ctx, repo._id, query, 16).catch(() => []);
    const ranked = hybridRank({ vector, text: text.map((hit, rank) => ({ path: hit.path, score: 1 / (1 + rank), startLine: hit.line })) }, limit);
    const windows = ranked.map((r) => { const start = r.startLine ?? 1, end = Math.min((r.endLine ?? start) + 2, start + 30); return { path: r.path, startLine: Math.max(1, start - 2), endLine: end }; });
    const excerpts = await ctx.runQuery(internal.searchData.excerpts, { repositoryId: repo._id, items: windows });
    for (const r of ranked) {
      const excerpt = excerpts.find((e) => e.path === r.path);
      results.push({ repositoryId: repo._id, repository: repo.fullName, path: r.path, startLine: excerpt?.startLine ?? r.startLine ?? 1, endLine: excerpt?.endLine ?? r.endLine ?? r.startLine ?? 1, snippet: redact(excerpt?.snippet ?? "").slice(0, 4000), score: r.score, reason: r.reason, revision: repo.indexedSha! });
    }
  }
  return results.sort((x, y) => y.score - x.score || x.repository.localeCompare(y.repository) || x.path.localeCompare(y.path)).slice(0, limit);
} });
