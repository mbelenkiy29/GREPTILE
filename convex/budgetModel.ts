"use node";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { modelFromEnvironment, type ModelCache } from "../src/engine/model";
import { InferenceBudgetError, type InferenceBilling } from "../src/inference-billing";
export function inferenceBilling(ctx: ActionCtx): InferenceBilling {
  return {
    async reserve(quote) {
      try { return await ctx.runMutation(internal.inferenceBudget.reserve, quote); }
      catch { throw new InferenceBudgetError("Inference budget unavailable, exhausted, or model pricing unsupported; no provider request was sent"); }
    },
    async settle(id, usage) { await ctx.runMutation(internal.inferenceBudget.settle, { id: id as Id<"inferenceReservations">, ...usage }); },
  };
}
export function budgetModel(ctx: ActionCtx, model?: string, cache?: ModelCache) { return modelFromEnvironment(model, cache, inferenceBilling(ctx)); }
