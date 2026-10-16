import { query } from "./_generated/server";
import { v } from "convex/values";
import { authorizeRepository } from "./auth";
import { applicableRules } from "../src/rule-scopes";
export const get = query({
  args: {
    token: v.string(),
    repositoryId: v.id("repositories"),
    path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const {repo} = await authorizeRepository(ctx, args.token, args.repositoryId);
    const [symbols, edges, knowledge, rules] = await Promise.all([
      args.path
        ? ctx.db
            .query("symbols")
            .withIndex("by_file", (q) =>
              q.eq("repositoryId", repo._id).eq("filePath", args.path!),
            )
            .take(100)
        : ctx.db
            .query("symbols")
            .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
            .take(100),
      args.path
        ? ctx.db
            .query("relationships")
            .withIndex("by_from", (q) =>
              q.eq("repositoryId", repo._id).eq("from", args.path!),
            )
            .take(100)
        : ctx.db
            .query("relationships")
            .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
            .take(100),
      ctx.db
        .query("knowledgeEntries")
        .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
        .take(30),
      ctx.db
        .query("customRules")
        .withIndex("by_org", (q) => q.eq("organizationId", repo.organizationId))
        .take(100),
    ]);
    const file = args.path
      ? await ctx.db
          .query("repositoryFiles")
          .withIndex("by_path", (q) =>
            q.eq("repositoryId", repo._id).eq("path", args.path!),
          )
          .unique()
      : null;
    return {
      repository: repo,
      symbols,
      relationships: edges,
      knowledge,
      rules: applicableRules(rules.filter((r) => r.enabled), repo),
      file: file
        ? {
            path: file.path,
            sha: file.sha,
            url: await ctx.storage.getUrl(file.storageId),
          }
        : null,
    };
  },
});
