import { and, inArray, lt } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { reviewRuns } from "@/lib/db/schema";
import { pipelineEnv } from "@/lib/env";
import type { JobQueue } from "@/lib/jobs/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { runJobId } from "./request";
import { ACTIVE_STATUSES, IllegalTransitionError, runLogger, transition } from "./state";

/** A run is started at most this many times; an abandoned run past it ends `failed`. */
export const MAX_RUN_ATTEMPTS = 3;
/** How often the worker sweeps for abandoned runs. */
export const RECOVERY_INTERVAL_MS = 5 * 60_000;

export interface RecoveryDeps {
  db: Db;
  queue: JobQueue;
  now?: () => Date;
  staleMs?: number;
  log?: Logger;
}

export interface RecoveryResult {
  requeued: number[];
  failed: number[];
}

/** Without a queue lookup, a queued run is presumed lost only after this many stale periods (backlogs are normal). */
export const QUEUED_STALE_FACTOR = 6;

/**
 * Restart recovery (R6.6): finds non-terminal runs whose heartbeat is older than REVIEW_STALE_MS and queues them
 * again with trigger `recovery`, under a fresh job id.
 *
 * - A run that started (ingesting … publishing) and stopped beating was abandoned by a crashed worker: it goes back to
 *   `queued`. `attempts` counts starts (the claim increments it), so after {@link MAX_RUN_ATTEMPTS} it ends `failed`.
 * - A `queued` run is only waiting while its job is still in the queue (a backlog, a debounce, a retry backoff, or a
 *   rate-limit deferral): it is left alone. It is re-enqueued only when its job is gone (lost or removed) or failed;
 *   only a failed job counts as an attempt, so waiting never uses one up. When the queue cannot look jobs up, a
 *   queued run is presumed lost after {@link QUEUED_STALE_FACTOR} stale periods.
 *
 * A duplicate job is harmless: only one job can claim a queued run. This is a worker maintenance sweep across all
 * orgs (like delivery pruning); every write it makes is scoped to the run's own org.
 */
export async function recoverStaleRuns(deps: RecoveryDeps): Promise<RecoveryResult> {
  const log = deps.log ?? rootLog.child({ component: "review-recovery" });
  const now = deps.now?.() ?? new Date();
  const staleMs = deps.staleMs ?? pipelineEnv().REVIEW_STALE_MS;
  const stale = await deps.db
    .select()
    .from(reviewRuns)
    .where(and(inArray(reviewRuns.status, ACTIVE_STATUSES), lt(reviewRuns.heartbeatAt, new Date(now.getTime() - staleMs))))
    .orderBy(reviewRuns.id)
    .limit(500);
  const result: RecoveryResult = { requeued: [], failed: [] };
  for (const run of stale) {
    const ref = { orgId: run.orgId, runId: run.id };
    const runLog = runLogger(run, log);
    try {
      let attempts = run.attempts;
      if (run.status === "queued") {
        const state = run.jobId && deps.queue.jobState ? await deps.queue.jobState(run.jobId) : undefined;
        if (state === "pending") continue;
        if (state === undefined && run.heartbeatAt.getTime() > now.getTime() - staleMs * QUEUED_STALE_FACTOR) continue;
        if (state === "failed") attempts++;
      }
      if (attempts >= MAX_RUN_ATTEMPTS) {
        await transition(deps.db, ref, "failed", { attempts, error: `abandoned after ${attempts} attempts (no heartbeat since ${run.heartbeatAt.toISOString()})` }, { now, log });
        result.failed.push(run.id);
        continue;
      }
      const jobId = `${runJobId(run, attempts)}-rec${now.getTime().toString(36)}`;
      const reason = `recovered after no heartbeat since ${run.heartbeatAt.toISOString()}`;
      await transition(deps.db, ref, "queued", { jobId, attempts, statusReason: reason }, { now, log });
      await deps.queue.add(
        "review-pr",
        { runId: run.id, orgId: run.orgId, repoId: run.repoId, prNumber: run.prNumber, ...(run.headSha ? { headSha: run.headSha } : {}), trigger: "recovery" },
        { jobId },
      );
      result.requeued.push(run.id);
    } catch (err) {
      // A run that finished between the select and the transition is no longer stale.
      if (err instanceof IllegalTransitionError) continue;
      runLog.warn("review run recovery failed", { error: errorMessage(err) });
    }
  }
  if (result.requeued.length || result.failed.length) log.info("recovered stale review runs", { requeued: result.requeued, failed: result.failed });
  return result;
}
