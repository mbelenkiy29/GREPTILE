import type { Db } from "@/lib/db";
import type { GitHost } from "@/lib/git/types";
import { indexRepo } from "@/lib/indexer";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import { syncFeedback } from "@/lib/learning";
import { mineRules } from "@/lib/learning/mining";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
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
  /** Logger carrying the job's correlation ids (set by {@link runObservedJob}). */
  log?: Logger;
}

type Handlers = { [N in JobName]: (deps: JobDeps, data: JobPayloads[N]) => Promise<unknown> };

export const handlers: Handlers = {
  "index-repo": (deps, data) => indexRepo(deps, data),
  "review-pr": (deps, data) => runReviewJob(deps, data),
  "answer-mention": (deps, data) => answerMention(deps, data),
  "sync-feedback": (deps, data) => syncFeedback(deps, data),
  "mine-rules": (deps, data) => mineRules(deps, data),
};

export function runJob<N extends JobName>(deps: JobDeps, name: N, data: JobPayloads[N]) {
  const handler = handlers[name] as (deps: JobDeps, data: JobPayloads[N]) => Promise<unknown>;
  if (!handler) throw new Error(`unknown job ${name}`);
  return handler(deps, data);
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
  job: { name: string; id?: string; data: unknown; attemptsMade?: number },
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
    const result = await runJob({ ...deps, log: jobLog }, name, job.data as JobPayloads[typeof name]);
    const status = result && typeof result === "object" && "status" in result ? String((result as { status: unknown }).status) : undefined;
    jobLog.info("job completed", { durationMs: Math.round(performance.now() - started), ...(status ? { outcome: status } : {}) });
    return result;
  } catch (err) {
    jobLog.error("job failed", { durationMs: Math.round(performance.now() - started), error: errorMessage(err) });
    throw err;
  }
}
