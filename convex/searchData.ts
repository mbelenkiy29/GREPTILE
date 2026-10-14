import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { rateLimit } from "./rateLimit";

// Line excerpts for search results, read from the stored index chunks of one repository.
export const excerpts = internalQuery({ args: { repositoryId: v.id("repositories"), items: v.array(v.object({ path: v.string(), startLine: v.number(), endLine: v.number() })) }, handler: async (ctx, a) => {
  const out: { path: string; startLine: number; endLine: number; snippet: string }[] = [];
  for (const item of a.items.slice(0, 50)) {
    const lines = new Map<number, string>();
    for (const chunk of await ctx.db.query("codeChunks").withIndex("by_file", (q) => q.eq("repositoryId", a.repositoryId).eq("filePath", item.path)).take(200))
      chunk.content.split("\n").forEach((text, i) => { const n = chunk.startLine + i; if (n >= item.startLine && n <= item.endLine && !lines.has(n)) lines.set(n, text); });
    const numbers = [...lines.keys()].sort((x, y) => x - y);
    if (numbers.length) out.push({ path: item.path, startLine: numbers[0], endLine: numbers.at(-1)!, snippet: numbers.map((n) => lines.get(n)).join("\n") });
  }
  return out;
} });
export const limit = internalMutation({ args: { key: v.string(), maximum: v.number() }, handler: async (ctx, a) => { await rateLimit(ctx, a.key, a.maximum); } });
