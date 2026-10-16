"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { budgetModel } from "./budgetModel";
import { runRuleAssistant, type AssistantJob } from "../src/rule-assistant";
import { InferenceBudgetError } from "../src/inference-billing";
import { ModelFailure } from "../src/engine/model";

// Runs one rule-assistant request: one model call (inference budget enforced by budgetModel), output
// validated by schema and guard in runRuleAssistant, usage recorded, suggestions stored for approval.
export const run = internalAction({ args: { runId: v.id("ruleAssistantRuns") }, handler: async (ctx, a): Promise<void> => {
  const job = await ctx.runQuery(internal.ruleAssistant.context, a);
  if (!job) return;
  const { run } = job;
  const input: AssistantJob = run.kind === "draft"
    ? { kind: "draft", description: run.description ?? "", scope: { ...(run.repositoryId ? { repositoryId: run.repositoryId } : {}), ...(run.teamId ? { teamId: run.teamId } : {}), ...(run.repositoryPattern ? { repositoryPattern: run.repositoryPattern } : {}) }, rules: job.rules }
    : run.kind === "refine" ? { kind: "refine", rules: job.rules } : { kind: "suggest", rules: job.rules, findings: job.findings, conventions: job.conventions };
  try {
    const result = await runRuleAssistant(input, budgetModel(ctx));
    if (job.usageRepositoryId && result.usage.length) {
      const total = result.usage.reduce((t, u) => ({ inputTokens: t.inputTokens + u.inputTokens, outputTokens: t.outputTokens + u.outputTokens, estimatedCost: t.estimatedCost + u.estimatedCost, durationMs: t.durationMs + u.latencyMs }), { inputTokens: 0, outputTokens: 0, estimatedCost: 0, durationMs: 0 });
      await ctx.runMutation(internal.usage.record, { repositoryId: job.usageRepositoryId, kind: "rule-assistant", ...total });
    }
    await ctx.runMutation(internal.ruleAssistant.complete, { runId: run._id, suggestions: result.suggestions, rejected: result.rejected });
  } catch (error) {
    if (error instanceof ModelFailure && job.usageRepositoryId) await ctx.runMutation(internal.usage.record, { repositoryId: job.usageRepositoryId, kind: "rule-assistant", inputTokens: error.usage.inputTokens, outputTokens: error.usage.outputTokens, estimatedCost: error.usage.estimatedCost, durationMs: error.usage.latencyMs });
    // Provider and validation errors stay out of the dashboard; budget errors explain themselves.
    await ctx.runMutation(internal.ruleAssistant.fail, { runId: run._id, error: error instanceof InferenceBudgetError ? error.message : "The model did not return a usable answer; nothing was suggested." });
  }
} });
