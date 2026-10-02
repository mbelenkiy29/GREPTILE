import type { Db } from "@/lib/db";
import type { GitHost } from "@/lib/git/types";
import { indexRepo } from "@/lib/indexer";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import { syncFeedback } from "@/lib/learning";
import { mineRules } from "@/lib/learning/mining";
import { answerMention } from "@/lib/review/mention";
import { runReviewJob } from "@/lib/review/run";
import type { JobName, JobPayloads, JobQueue } from "./types";

export interface JobDeps {
  db: Db;
  host: GitHost;
  queue: JobQueue;
  llm: LlmProvider;
  embedder: EmbeddingProvider;
  cacheDir: string;
  botMention: string;
}

/** Queue-side facts about the job being run (BullMQ job id), when the runner has them. */
export interface JobMeta {
  queueJobId?: string;
}

type Handlers = { [N in JobName]: (deps: JobDeps, data: JobPayloads[N], meta?: JobMeta) => Promise<unknown> };

export const handlers: Handlers = {
  "index-repo": (deps, data, meta) => indexRepo(deps, { ...data, queueJobId: meta?.queueJobId }),
  "review-pr": (deps, data) => runReviewJob(deps, data),
  "answer-mention": (deps, data) => answerMention(deps, data),
  "sync-feedback": (deps, data) => syncFeedback(deps, data),
  "mine-rules": (deps, data) => mineRules(deps, data),
};

export function runJob<N extends JobName>(deps: JobDeps, name: N, data: JobPayloads[N], meta?: JobMeta) {
  const handler = handlers[name] as (deps: JobDeps, data: JobPayloads[N], meta?: JobMeta) => Promise<unknown>;
  if (!handler) throw new Error(`unknown job ${name}`);
  return handler(deps, data, meta);
}

/**
 * Delay after which a job that failed with `err` should run again without using up one of its queue attempts, or
 * null for an ordinary failure. Errors opt in with a numeric `retryAfterMs` (e.g. `IndexLockedError` while another
 * index run of the repository holds its lock), so a push that arrives during a long index is never dropped.
 */
export function retryAfterMs(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("retryAfterMs" in err)) return null;
  const ms = (err as { retryAfterMs: unknown }).retryAfterMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : null;
}
