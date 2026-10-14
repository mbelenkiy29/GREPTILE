import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

// Read-only data access for the agentic reviewer. Every query is bound to a repository ID that
// the review job supplies server-side; model-chosen strings only filter within that repository.
const repositoryId = v.id("repositories");
const wordPattern = (symbol: string) => new RegExp(`(^|[^A-Za-z0-9_$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_$])`);

export const search = internalQuery({ args: { repositoryId, query: v.string() }, handler: async (ctx, a) => {
  const repo = await ctx.db.get(a.repositoryId);
  const query = a.query.trim().slice(0, 200);
  if (!repo || query.length < 2) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const chunks = await ctx.db.query("codeChunks").withSearchIndex("by_content", (q) => q.search("content", query).eq("repositoryId", repo._id).eq("organizationId", repo.organizationId)).take(20);
  return chunks.map((c) => {
    const lines = c.content.split("\n"), hit = Math.max(0, lines.findIndex((line) => terms.some((t) => line.toLowerCase().includes(t))));
    return { path: c.filePath, line: c.startLine + hit, snippet: lines[hit] ?? "" };
  });
} });

export const definitions = internalQuery({ args: { repositoryId, symbol: v.string() }, handler: async (ctx, a) =>
  (await ctx.db.query("symbols").withIndex("by_name", (q) => q.eq("repositoryId", a.repositoryId).eq("name", a.symbol.slice(0, 200))).take(20)).map((s) => ({ path: s.filePath, line: s.line, kind: s.kind })),
});

export const references = internalQuery({ args: { repositoryId, symbol: v.string() }, handler: async (ctx, a) => {
  const repo = await ctx.db.get(a.repositoryId);
  const symbol = a.symbol.trim().slice(0, 200);
  if (!repo || !symbol) return [];
  const pattern = wordPattern(symbol), out: { path: string; line: number; snippet: string }[] = [];
  const chunks = await ctx.db.query("codeChunks").withSearchIndex("by_content", (q) => q.search("content", symbol).eq("repositoryId", repo._id).eq("organizationId", repo.organizationId)).take(40);
  for (const c of chunks)
    for (const [i, line] of c.content.split("\n").entries())
      if (pattern.test(line) && out.length < 30 && !out.some((o) => o.path === c.filePath && o.line === c.startLine + i)) out.push({ path: c.filePath, line: c.startLine + i, snippet: line });
  return out;
} });

export const directory = internalQuery({ args: { repositoryId, path: v.string() }, handler: async (ctx, a) => {
  const prefix = a.path ? a.path.replace(/\/+$/, "") + "/" : "";
  const rows = await ctx.db.query("repositoryFiles").withIndex("by_path", (q) => (prefix ? q.eq("repositoryId", a.repositoryId).gte("path", prefix).lt("path", prefix + "￿") : q.eq("repositoryId", a.repositoryId))).take(3000);
  return [...new Set(rows.map((r) => prefix + r.path.slice(prefix.length).split("/")[0]))].slice(0, 200);
} });

export const related = internalQuery({ args: { repositoryId, path: v.string() }, handler: async (ctx, a) => {
  const out = new Map<string, string>();
  for (const e of await ctx.db.query("relationships").withIndex("by_from", (q) => q.eq("repositoryId", a.repositoryId).eq("from", a.path)).take(50)) if (e.to !== a.path) out.set(e.to, e.kind);
  for (const e of await ctx.db.query("relationships").withIndex("by_to", (q) => q.eq("repositoryId", a.repositoryId).eq("to", a.path)).take(50)) if (e.from !== a.path) out.set(e.from, e.kind + " (incoming)");
  return [...out].slice(0, 40).map(([path, reason]) => ({ path, reason }));
} });

export const pastFindings = internalQuery({ args: { repositoryId, path: v.string() }, handler: async (ctx, a) =>
  (await ctx.db.query("findings").withIndex("by_repo_path", (q) => q.eq("repositoryId", a.repositoryId).eq("filePath", a.path)).order("desc").take(20)).map((f) => ({ title: f.title, severity: f.severity, status: f.status, filePath: f.filePath })),
});
