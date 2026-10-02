import { eq, gte, lt, sql } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { modelCalls } from "@/lib/db/schema";
import { errorMessage, log, type Logger } from "@/lib/log";

/** How a logical model call ended. */
export type ModelCallStatus = "ok" | "error" | "refused" | "cache_hit";

/** One `model_calls` row (R6.15): one per logical call, retries included. */
export interface ModelCallRecord {
  orgId: string | null;
  repoId: number | null;
  reviewRunId: number | null;
  agentRunId: number | null;
  task: string;
  mode: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  /** Estimated USD; null when the model has no known price. */
  costUsd: number | null;
  status: ModelCallStatus;
  error: string | null;
  attempts: number;
}

export interface ModelCallRecorder {
  record(call: ModelCallRecord): Promise<void>;
}

/** Writes rows to `model_calls`. */
export class PostgresModelCallRecorder implements ModelCallRecorder {
  constructor(private readonly db: Db) {}

  async record(call: ModelCallRecord): Promise<void> {
    await this.db.insert(modelCalls).values(call);
  }
}

/** Keeps rows in memory (tests, CLI runs without a database). */
export class InMemoryModelCallRecorder implements ModelCallRecorder {
  readonly calls: (ModelCallRecord & { createdAt: Date })[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  async record(call: ModelCallRecord): Promise<void> {
    this.calls.push({ ...call, createdAt: new Date(this.now()) });
  }

  /** Summed tokens and estimated cost; `unpricedCalls` counts calls whose cost is unknown. */
  totals() {
    return this.calls.reduce(
      (t, c) => ({
        calls: t.calls + 1,
        inputTokens: t.inputTokens + c.inputTokens,
        outputTokens: t.outputTokens + c.outputTokens,
        cacheReadTokens: t.cacheReadTokens + c.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens + c.cacheWriteTokens,
        costUsd: Math.round((t.costUsd + (c.costUsd ?? 0)) * 1e6) / 1e6,
        unpricedCalls: t.unpricedCalls + (c.costUsd === null ? 1 : 0),
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpricedCalls: 0 },
    );
  }
}

/** Records a call without ever failing it: recorder errors are logged and swallowed. */
export async function recordSafely(recorder: ModelCallRecorder | undefined, call: ModelCallRecord, logger: Logger = log): Promise<void> {
  if (!recorder) return;
  try {
    await recorder.record(call);
  } catch (err) {
    logger.warn("failed to record model call", { error: errorMessage(err), task: call.task, model: call.model, status: call.status });
  }
}

export interface ModelCallTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of priced calls. */
  costUsd: number;
  /** Calls (other than cache hits) whose model has no known price; `costUsd` excludes them. */
  unpricedCalls: number;
}

/**
 * An org's model usage, optionally for one review run (estimated model cost per pull request, R6.16) or repo,
 * and a time window.
 */
export async function modelCallTotals(
  db: Db,
  orgId: string,
  filter: { reviewRunId?: number; repoId?: number; since?: Date; until?: Date } = {},
): Promise<ModelCallTotals> {
  const [row] = await db
    .select({
      calls: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${modelCalls.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${modelCalls.outputTokens}), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum(${modelCalls.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum(${modelCalls.cacheWriteTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)`,
      unpricedCalls: sql<string>`count(*) filter (where ${modelCalls.costUsd} is null and ${modelCalls.status} <> 'cache_hit')`,
    })
    .from(modelCalls)
    .where(
      scoped(
        modelCalls,
        orgId,
        filter.reviewRunId !== undefined ? eq(modelCalls.reviewRunId, filter.reviewRunId) : undefined,
        filter.repoId !== undefined ? eq(modelCalls.repoId, filter.repoId) : undefined,
        filter.since ? gte(modelCalls.createdAt, filter.since) : undefined,
        filter.until ? lt(modelCalls.createdAt, filter.until) : undefined,
      ),
    );
  return {
    calls: Number(row?.calls ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    cacheReadTokens: Number(row?.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row?.cacheWriteTokens ?? 0),
    costUsd: Number(row?.costUsd ?? 0),
    unpricedCalls: Number(row?.unpricedCalls ?? 0),
  };
}
