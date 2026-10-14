import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
export const status = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    paths: v.array(v.string()),
    attempt: v.number(),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return;
    await ctx.db.patch(repo._id, {
      knowledgeStatus: args.status,
      knowledgeError: args.error,
      knowledgePaths: args.paths,
      knowledgeAttempt: args.attempt,
      knowledgeUpdatedAt: Date.now(),
    });
    if (args.status === "failed" && args.attempt < 3)
      await ctx.scheduler.runAfter(
        10000 * args.attempt,
        internal.knowledgeJobs.generate,
        {
          repositoryId: repo._id,
          paths: args.paths,
          attempt: args.attempt + 1,
        },
      );
  },
});
export const save = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    sha: v.string(),
    entries: v.array(
      v.object({
        subsystem: v.string(),
        description: v.string(),
        files: v.array(v.string()),
        dependencies: v.array(v.string()),
        risks: v.array(v.string()),
        conventions: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    for (const entry of args.entries) {
      const existing = await ctx.db
        .query("knowledgeEntries")
        .withIndex("by_subsystem", (q) =>
          q.eq("repositoryId", repo._id).eq("subsystem", entry.subsystem),
        )
        .unique();
      const data = {
        ...entry,
        organizationId: repo.organizationId,
        repositoryId: repo._id,
        sha: args.sha,
        updatedAt: Date.now(),
      };
      if (existing) await ctx.db.patch(existing._id, data);
      else await ctx.db.insert("knowledgeEntries", data);
    }
  },
});
