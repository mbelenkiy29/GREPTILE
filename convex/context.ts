import { internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { authorizeRepository } from "./auth";
import { rankNeighborhood, traversable, directoryOf } from "../src/engine/graph";

export const related = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    paths: v.array(v.string()),
    identifiers: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const related = new Set<string>();
    for (const path of args.paths) {
      for (const edge of await ctx.db
        .query("relationships")
        .withIndex("by_from", (q) =>
          q.eq("repositoryId", args.repositoryId).eq("from", path),
        )
        .take(100))
        related.add(edge.to);
      for (const edge of await ctx.db
        .query("relationships")
        .withIndex("by_to", (q) =>
          q.eq("repositoryId", args.repositoryId).eq("to", path),
        )
        .take(100))
        related.add(edge.from);
    }
    for (const identifier of args.identifiers.slice(0, 100))
      for (const symbol of await ctx.db
        .query("symbols")
        .withIndex("by_name", (q) =>
          q.eq("repositoryId", args.repositoryId).eq("name", identifier),
        )
        .take(20))
        related.add(symbol.filePath);
    for (const identifier of args.identifiers.slice(0, 8)) {
      for (const chunk of await ctx.db
        .query("codeChunks")
        .withSearchIndex("by_content", (q) =>
          q.search("content", identifier).eq("repositoryId", args.repositoryId),
        )
        .take(10))
        related.add(chunk.filePath);
    }
    const files = await ctx.db
      .query("repositoryFiles")
      .withIndex("by_repo", (q) => q.eq("repositoryId", args.repositoryId))
      .take(2000);
    for (const f of files)
      if (/(README|AGENTS|schema|package\.json|config)/i.test(f.path))
        related.add(f.path);
    return { paths: [...related].slice(0, 80) };
  },
});
export const search = query({
  args: {
    token: v.string(),
    repositoryId: v.id("repositories"),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    await authorizeRepository(ctx, args.token, repo._id);
    if (!args.query.trim() || args.query.length > 100)
      throw new Error("Search query must be 1–100 characters");
    const symbols = await ctx.db
      .query("symbols")
      .withIndex("by_name", (q) =>
        q.eq("repositoryId", repo._id).eq("name", args.query),
      )
      .take(50);
    const files = (
      await ctx.db
        .query("repositoryFiles")
        .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
        .take(2000)
    )
      .filter((f) => f.path.toLowerCase().includes(args.query.toLowerCase()))
      .slice(0, 50);
    const matches = await ctx.db
      .query("codeChunks")
      .withSearchIndex("by_content", (q) =>
        q
          .search("content", args.query)
          .eq("repositoryId", repo._id)
          .eq("organizationId", repo.organizationId),
      )
      .take(30);
    return {
      symbols,
      files: files.map((f) => ({ path: f.path, sha: f.sha })),
      matches: matches.map((m) => ({
        path: m.filePath,
        startLine: m.startLine,
        content: m.content,
      })),
    };
  },
});

// Bounded 1–3 hop ranked traversal over resolved graph edges (both directions). Directory
// targets (packages) expand to their files; at most ~4 index ranges per visited node.
export const neighborhood = internalQuery({
  args: { repositoryId: v.id("repositories"), paths: v.array(v.string()), hops: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const repositoryId = args.repositoryId;
    const filesIn = async (dir: string) => (await ctx.db.query("repositoryFiles").withIndex("by_path", (q) => q.eq("repositoryId", repositoryId).gte("path", dir).lt("path", dir + "\uffff")).take(40)).map((f) => f.path).filter((p) => !p.slice(dir.length).includes("/")).slice(0, 20);
    return rankNeighborhood(args.paths.slice(0, 50), async (path) => {
      const out: { path: string; kind: string; incoming: boolean }[] = [];
      for (const e of await ctx.db.query("relationships").withIndex("by_from", (q) => q.eq("repositoryId", repositoryId).eq("from", path)).take(80))
        if (traversable(e)) for (const target of e.to.endsWith("/") ? await filesIn(e.to) : [e.to]) out.push({ path: target, kind: e.kind, incoming: false });
      const dir = directoryOf(path);
      for (const to of dir ? [path, dir] : [path])
        for (const e of await ctx.db.query("relationships").withIndex("by_to", (q) => q.eq("repositoryId", repositoryId).eq("to", to)).take(60))
          if (traversable(e)) out.push({ path: e.from, kind: e.kind, incoming: true });
      return out;
    }, { hops: args.hops ?? 2, limit: args.limit ?? 40 });
  },
});
