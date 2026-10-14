"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { provider } from "./scm";
import { budgetModel } from "./budgetModel";
import { clusterConventions, conventionSchema, conventionSystem, usableComments } from "../src/conventions";

// Incrementally learns team conventions from human review comments on merged pull requests:
// bounded fetch → model extraction (fake-model tested) → cluster → guardrails → suggestions.
export const ingest = internalAction({ args: { repositoryId: v.id("repositories") }, handler: async (ctx, a): Promise<{ added: number; merged: number; rejected: number }> => {
  const { repo } = await ctx.runQuery(internal.repositories.data, a);
  const none = { added: 0, merged: 0, rejected: 0 };
  if (!repo.enabled) return none;
  const scm = await provider(ctx, repo);
  if (!scm.mergedReviewComments) return none;
  const batch = await scm.mergedReviewComments(repo.fullName, repo.conventionsCursor ?? 0, 10);
  const comments = usableComments(batch.comments);
  if (comments.length < 3) return ctx.runMutation(internal.conventions.record, { repositoryId: repo._id, cursor: batch.cursor, candidates: [] });
  const extracted = await budgetModel(ctx).generate({ task: "knowledge:conventions", system: conventionSystem, input: { comments: comments.map((c, index) => ({ index, path: c.path ?? null, text: c.body })) } }, conventionSchema(comments.length));
  await ctx.runMutation(internal.usage.record, { repositoryId: repo._id, kind: "conventions", inputTokens: extracted.usage.inputTokens, outputTokens: extracted.usage.outputTokens, estimatedCost: extracted.usage.estimatedCost, durationMs: extracted.usage.latencyMs });
  const candidates = clusterConventions(extracted.value.conventions.map((c) => ({ text: c.text, category: c.category, evidence: [...new Set(c.evidence)].map((i) => ({ url: comments[i].url, author: comments[i].author, excerpt: comments[i].body.slice(0, 200) })) })));
  return ctx.runMutation(internal.conventions.record, { repositoryId: repo._id, cursor: batch.cursor, candidates });
} });
export const sweep = internalAction({ args: {}, handler: async (ctx): Promise<number> => {
  const due = await ctx.runQuery(internal.conventions.due, { limit: 10 });
  for (const [i, repo] of due.entries()) await ctx.scheduler.runAfter(i * 30000, internal.conventionJobs.ingest, { repositoryId: repo.repositoryId });
  return due.length;
} });
