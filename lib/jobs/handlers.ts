import type { Db } from "@/lib/db";
import type { GitHost } from "@/lib/git/types";
import { indexRepo } from "@/lib/indexer";
import { afterIndexCompleted, refreshKnowledge } from "@/lib/knowledge";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import { syncFeedback } from "@/lib/learning";
import { mineRules } from "@/lib/learning/mining";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { answerMention } from "@/lib/conversations";
import { reportUsage } from "@/lib/billing/report";
import { runReviewJob } from "@/lib/review/run";
import type { RuntimeValidationDeps } from "@/lib/sandbox/validate";
import type { JobName, JobPayloads, JobQueue } from "./types";

export interface JobDeps {
  db: Db;
  host: GitHost;
  queue: JobQueue;
  llm: LlmProvider;
  embedder: EmbeddingProvider;
  cacheDir: string;
  botMention: string;
  /** Runtime validation sandbox (R4.5); built from the environment by the worker. */
  sandbox?: RuntimeValidationDeps;
  /** Logger carrying the job's correlation ids (set by {@link runObservedJob}). */
  log?: Logger;
}

/** Queue-side facts about the job being run (BullMQ job id), when the runner has them. */
export interface RunMeta {
  queueJobId?: string;
  /** Attempts the queue already made for this job before this one (0 on the first run). */
  attemptsMade?: number;
  /** Attempts the queue allows this job in total. */
  maxAttempts?: number;
}

type Handlers = { [N in JobName]: (deps: JobDeps, data: JobPayloads[N], meta?: RunMeta) => Promise<unknown> };

export const handlers: Handlers = {
  "index-repo": async (deps, data, meta) => {
    // A default-branch switch re-indexes the newly indexed branch, which the index records as a push.
    const result = await indexRepo(deps, { ...data, trigger: data.trigger === "default_branch" ? "push" : data.trigger, queueJobId: meta?.queueJobId });
    // A completed index with changes refreshes the knowledge base (R6.12).
    await afterIndexCompleted(deps, { orgId: data.orgId, repoId: data.repoId, meta: data.meta }, result);
    return result;
  },
  "review-pr": (deps, data, meta) => runReviewJob(deps, data, meta),
  "answer-mention": (deps, data) => answerMention(deps, data),
  "sync-feedback": (deps, data) => syncFeedback(deps, data),
  "mine-rules": (deps, data) => mineRules(deps, data),
  "refresh-knowledge": (deps, data) => refreshKnowledge(deps, data),
  "report-usage": (deps) => reportUsage({ db: deps.db, log: deps.log }),
};

export function runJob<N extends JobName>(deps: JobDeps, name: N, data: JobPayloads[N], meta?: RunMeta) {
  const handler = handlers[name] as (deps: JobDeps, data: JobPayloads[N], meta?: RunMeta) => Promise<unknown>;
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

/** Correlation ids for a job's log lines, taken from its payload (R6.21). */
export function jobLogContext(job: { name: string; id?: string; data: unknown; attemptsMade?: number }) {
  const data = (job.data ?? {}) as Partial<{ orgId: string; repoId: number; prNumber: number; meta: { deliveryId?: string; requestedBy?: string } }>;
  return {
    job: job.name,
    ...(job.id ? { jobId: job.id } : {}),
    ...(data.orgId ? { orgId: data.orgId } : {}),
    ...(typeof data.repoId === "number" ? { repoId: data.repoId } : {}),
    ...(typeof data.prNumber === "number" ? { prNumber: data.prNumber } : {}),
    ...(data.meta?.deliveryId ? { deliveryId: data.meta.deliveryId } : {}),
    ...(data.meta?.requestedBy ? { requestedBy: data.meta.requestedBy } : {}),
    attempt: (job.attemptsMade ?? 0) + 1,
  };
}

/**
 * Runs one queued job with start / complete / fail logs carrying its correlation ids and duration (R6.21).
 * Errors are rethrown so the queue can retry the job.
 */
export async function runObservedJob(
  deps: JobDeps,
  job: { name: string; id?: string; data: unknown; attemptsMade?: number; maxAttempts?: number },
  logger: Logger = deps.log ?? rootLog,
) {
  const jobLog = logger.child(jobLogContext(job));
  if (!(job.name in handlers)) {
    jobLog.error("unknown job");
    throw new Error(`unknown job ${job.name}`);
  }
  const name = job.name as JobName;
  jobLog.info("job started");
  const started = performance.now();
  try {
    const result = await runJob({ ...deps, log: jobLog }, name, job.data as JobPayloads[typeof name], {
      ...(job.id ? { queueJobId: job.id } : {}),
      ...(job.attemptsMade !== undefined ? { attemptsMade: job.attemptsMade } : {}),
      ...(job.maxAttempts !== undefined ? { maxAttempts: job.maxAttempts } : {}),
    });
    const status = result && typeof result === "object" && "status" in result ? String((result as { status: unknown }).status) : undefined;
    jobLog.info("job completed", { durationMs: Math.round(performance.now() - started), ...(status ? { outcome: status } : {}) });
    return result;
  } catch (err) {
    jobLog.error("job failed", { durationMs: Math.round(performance.now() - started), error: errorMessage(err) });
    throw err;
  }
}
