"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { provider } from "./scm";

// Polls reactions on OpenReview's finding comments for one pull request (GitHub has no reaction
// webhooks). Runs when a pull request closes or merges and from a bounded hourly sweep.
export const sync = internalAction({ args: { repositoryId: v.id("repositories"), prNumber: v.number() }, handler: async (ctx, a): Promise<{ added: number; removed: number }> => {
  const { repo } = await ctx.runQuery(internal.repositories.data, { repositoryId: a.repositoryId });
  if (!repo.enabled) return { added: 0, removed: 0 };
  const scm = await provider(ctx, repo);
  if (!scm.reactions) return { added: 0, removed: 0 };
  const targets = (await ctx.runQuery(internal.reactions.targets, a)).filter((t) => /^\d+$/.test(t.commentId));
  if (!targets.length) return { added: 0, removed: 0 };
  const observed = await scm.reactions(repo.fullName, targets.map((t) => Number(t.commentId)));
  return ctx.runMutation(internal.reactions.apply, { ...a, provider: "github", targets, observed });
} });
export const sweep = internalAction({ args: {}, handler: async (ctx): Promise<number> => {
  const due = await ctx.runQuery(internal.reactions.due, { limit: 25 });
  for (const [i, pr] of due.entries()) await ctx.scheduler.runAfter(i * 5000, internal.reactionJobs.sync, pr);
  return due.length;
} });
