import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
export const record = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    kind: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    estimatedCost: v.number(),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return;
    await ctx.db.insert("usageEvents", {
      ...args,
      organizationId: repo.organizationId,
      createdAt: Date.now(),
    });
  },
});
