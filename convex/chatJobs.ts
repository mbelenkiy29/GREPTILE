"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { budgetModel } from "./budgetModel";
import { chatToolbox } from "./agentToolbox";
import { runChatAgent } from "../src/engine/chat";
import { ModelFailure } from "../src/engine/model";
import { repositorySourceUrl } from "../src/source-url";
import type { ModelUsage } from "../src/engine/types";

// Runs one chat answer: the A2 tool loop with chat budgets, progress persisted as events (read by
// the SSE route), inference budget enforced by budgetModel, usage and cost recorded.
export const answer = internalAction({ args: { messageId: v.id("chatMessages") }, handler: async (ctx, a): Promise<void> => {
  let job;
  try { job = await ctx.runQuery(internal.chat.job, { messageId: a.messageId }); }
  catch (error) { await ctx.runMutation(internal.chat.fail, { messageId: a.messageId, error: error instanceof Error ? error.message : "Chat unavailable" }); return; }
  if (!job || !await ctx.runMutation(internal.chat.start, { messageId: a.messageId })) return;
  const usage: ModelUsage[] = [];
  const record = async () => {
    const total = usage.reduce((t, u) => ({ inputTokens: t.inputTokens + u.inputTokens, outputTokens: t.outputTokens + u.outputTokens, estimatedCost: t.estimatedCost + u.estimatedCost, latencyMs: t.latencyMs + u.latencyMs }), { inputTokens: 0, outputTokens: 0, estimatedCost: 0, latencyMs: 0 });
    if (usage.length) await ctx.runMutation(internal.usage.record, { repositoryId: job.repositories[0].repo._id, kind: "chat", inputTokens: total.inputTokens, outputTokens: total.outputTokens, estimatedCost: total.estimatedCost, durationMs: total.latencyMs });
    return total;
  };
  try {
    const run = await runChatAgent({
      question: job.question,
      history: job.history,
      repositories: job.repositories.map(({ repo }) => ({ name: repo.fullName, tools: chatToolbox(ctx, repo) })),
      model: budgetModel(ctx),
      usage,
      onEvent: (event) => ctx.runMutation(internal.chat.event, { messageId: a.messageId, ...event }),
    });
    const total = await record();
    if (!run.answer) { await ctx.runMutation(internal.chat.fail, { messageId: a.messageId, error: "No answer with citations that match the indexed source was produced.", limits: run.limits }); return; }
    const citations = run.answer.citations.map((c) => {
      const { repo, source } = job.repositories.find((r) => r.repo.fullName === c.repository)!;
      let url: string | undefined;
      try { url = source ? repositorySourceUrl(source.kind, source.instance, repo.fullName, c.revision, c.filePath, repo.externalId) + (source.kind === "github" || source.kind === "github-enterprise" ? `#L${c.startLine}${c.endLine > c.startLine ? "-L" + c.endLine : ""}` : source.kind === "gitlab" ? `#L${c.startLine}${c.endLine > c.startLine ? "-" + c.endLine : ""}` : "") : undefined; } catch { url = undefined; }
      return { ...c, repositoryId: repo._id, ...(url ? { url } : {}) };
    });
    await ctx.runMutation(internal.chat.complete, { messageId: a.messageId, content: run.answer.text, citations, limits: run.limits, inputTokens: total.inputTokens, outputTokens: total.outputTokens, estimatedCost: total.estimatedCost });
  } catch (error) {
    if (error instanceof ModelFailure && !usage.includes(error.usage)) usage.push(error.usage);
    await record().catch(() => undefined);
    await ctx.runMutation(internal.chat.fail, { messageId: a.messageId, error: error instanceof Error ? error.message.slice(0, 300) : "Chat failed" });
  }
} });
