/**
 * Model calls made by the engine: every call goes through the injected provider (normally the gateway, H4) with a
 * task, the review mode, and correlation ids; results are accounted per agent (model that served it, tokens, cost,
 * latency). Cancellation (an aborted signal, `LlmAbortError`, or `CancelledError` from a hook) always propagates as
 * `CancelledError`.
 */
import { addUsage, BUILTIN_PRICING, estimateCost, LlmAbortError, pricingTable, type PricingTable, LlmError, ZERO_USAGE, type ChatTask, type JsonRequest, type ResolvedRoute, type Usage } from "@/lib/llm";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { CancelledError, type AgentRunRecord, type EngineDeps, type ReviewMode, type ReviewRequest } from "./types";

let pricing: PricingTable | undefined;

/** Built-in prices merged with `LLM_PRICING_JSON` (an invalid override falls back to the built-in table). */
function prices(): PricingTable {
  if (!pricing) {
    try {
      pricing = pricingTable(process.env.LLM_PRICING_JSON || undefined);
    } catch {
      pricing = BUILTIN_PRICING;
    }
  }
  return pricing;
}

export function costOf(model: string | null, usage: Usage): number | null {
  return model ? estimateCost(model, usage, prices()) : null;
}

export interface EngineContext {
  deps: EngineDeps;
  req: ReviewRequest;
  nonce: string;
  log: Logger;
  now: () => number;
  records: AgentRunRecord[];
}

export function createContext(deps: EngineDeps, req: ReviewRequest, nonce: string): EngineContext {
  return {
    deps,
    req,
    nonce,
    log: (deps.log ?? rootLog).child({ component: "engine", orgId: req.orgId, repoId: req.repo.id, ...(req.meta?.reviewRunId ? { reviewRunId: req.meta.reviewRunId } : {}) }),
    now: deps.now ?? Date.now,
    records: [],
  };
}

export function isCancellation(err: unknown, signal?: AbortSignal): boolean {
  return err instanceof CancelledError || err instanceof LlmAbortError || (err instanceof Error && err.name === "AbortError") || !!signal?.aborted;
}

export function toCancelled(err: unknown): CancelledError {
  if (err instanceof CancelledError) return err;
  const out = new CancelledError(err instanceof Error ? err.message : "review cancelled");
  if (err instanceof Error) out.cause = err;
  return out;
}

export function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw toCancelled(signal.reason instanceof Error ? signal.reason : new CancelledError());
}

export interface CallOutcome<T> {
  data: T;
  model: string | null;
  usage: Usage;
  costUsd: number | null;
  latencyMs: number;
}

export interface CallFailure {
  error: unknown;
  model: string | null;
  usage: Usage;
  costUsd: number | null;
  latencyMs: number;
}

/** One structured model call; returns the failure (never throws) unless it is a cancellation. */
export async function callJson<T>(
  ctx: EngineContext,
  agent: string,
  req: Omit<JsonRequest<T>, "meta" | "signal" | "mode" | "task"> & { task: ChatTask; mode?: ReviewMode },
): Promise<{ ok: true; value: CallOutcome<T> } | { ok: false; failure: CallFailure }> {
  const started = ctx.now();
  const { llm } = ctx.deps;
  throwIfCancelled(ctx.req.signal);
  try {
    const result = await llm.json({
      ...req,
      mode: req.mode ?? ctx.req.mode,
      signal: ctx.req.signal,
      meta: { orgId: ctx.req.orgId, repoId: ctx.req.repo.id, reviewRunId: ctx.req.meta?.reviewRunId ?? null, agent },
    });
    const route = (result as { route?: ResolvedRoute }).route;
    // The model that actually answered (a provider-side fallback reports it), as the gateway records it.
    const model = result.servedModel ?? route?.model ?? (llm.model || null);
    const cached = (result as { cached?: boolean }).cached === true;
    return {
      ok: true,
      value: {
        data: result.data,
        model,
        usage: result.usage,
        costUsd: cached ? 0 : costOf(model, result.usage),
        latencyMs: ctx.now() - started,
      },
    };
  } catch (err) {
    if (isCancellation(err, ctx.req.signal)) throw toCancelled(err);
    const usage = err instanceof LlmError ? (err.usage ?? ZERO_USAGE) : ZERO_USAGE;
    const model = req.model ?? (llm.model || null);
    ctx.log.warn("engine model call failed", { agent, task: req.task, error: errorMessage(err) });
    return { ok: false, failure: { error: err, model, usage, costUsd: costOf(model, usage), latencyMs: ctx.now() - started } };
  }
}

/** Records one finished agent/stage run and reports it to the hook as soon as it finishes. */
export async function record(ctx: EngineContext, run: AgentRunRecord): Promise<void> {
  ctx.records.push(run);
  await ctx.deps.hooks?.onAgentRun?.(run);
}

/** Sum of usage and cost across runs; cost is null when any run's cost is unknown. */
export function totals(records: AgentRunRecord[]): Usage & { costUsd: number | null; calls: number } {
  let usage: Usage = ZERO_USAGE;
  let cost: number | null = 0;
  let calls = 0;
  for (const r of records) {
    if (r.status === "skipped") continue;
    usage = addUsage(usage, r.usage);
    calls++;
    cost = cost === null || r.costUsd === null ? null : cost + r.costUsd;
  }
  return { ...usage, costUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6, calls };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (next < items.length && failed === undefined) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== undefined) throw failed;
  return out;
}
