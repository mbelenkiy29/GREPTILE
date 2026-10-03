/**
 * Requesting and cancelling review runs (R6.6, R6.16, S30). Every way a review starts (webhooks, dashboard
 * re-review, mention commands, REST API, CLI) goes through {@link requestReview}: it records a `review_runs` row
 * and enqueues the `review-pr` job for it. A newer run for the same PR supersedes older ones.
 */
import { desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { reviewGate, type EffectiveSettings } from "@/lib/config/settings";
import type { Db } from "@/lib/db";
import { repos, reviewRuns, reviews } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import type { ReviewFocus, ReviewMode } from "@/lib/engine/types";
import { pipelineEnv } from "@/lib/env";
import type { JobMeta, JobQueue, ReviewTrigger } from "@/lib/jobs/types";
import { log as rootLog, type Logger } from "@/lib/log";
import { lockPrRequests } from "./lock";
import { ACTIVE_STATUSES, getRun, isTerminal, runLogger, transition, type RunRow } from "./state";

/** Triggers that come from webhooks; duplicates for the same head are deduped against runs already in flight. */
const WEBHOOK_TRIGGERS: ReadonlySet<ReviewTrigger> = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export interface RequestReviewInput {
  orgId: string;
  repoId: number;
  prNumber: number;
  /** Head commit to review; omitted = the PR's head when the run starts. */
  headSha?: string;
  trigger: Exclude<ReviewTrigger, "recovery">;
  mode?: ReviewMode;
  focus?: ReviewFocus;
  /** Review everything again, ignoring the incremental baseline (manual "full" re-review). */
  full?: boolean;
  requestedBy?: string;
  meta?: JobMeta;
}

/**
 * What a webhook knows about the PR, to apply the automatic-review gates (R6.14) BEFORE a run is recorded, so a
 * gated event never supersedes or cancels a run that should have finished. `settings` are the effective settings
 * (org ← repo ← openreview.json when it could be read). The job checks the gates again with the PR it fetches.
 */
export interface RequestGate {
  draft: boolean;
  baseRef?: string;
  headRef?: string;
  settings: EffectiveSettings;
}

/** A webhook request that the settings gates turned away: no run was recorded and nothing was superseded. */
export interface GatedRequest {
  gated: true;
  reason: string;
}

export interface RequestReviewDeps {
  db: Db;
  queue: JobQueue;
  /** Delay for push-triggered runs; defaults to REVIEW_DEBOUNCE_MS. */
  debounceMs?: number;
  log?: Logger;
}

export interface RequestedRun {
  runId: number;
  reviewId: number;
  jobId: string;
  /** True when an identical run (same PR head, already queued or running) was reused instead. */
  deduped: boolean;
}

export class ReviewRequestError extends Error {}

/** BullMQ job id for a run's `attempt`-th execution (recovery re-enqueues under a fresh id). */
export function runJobId(run: Pick<RunRow, "id" | "repoId" | "prNumber">, attempt = 0): string {
  return `review-${run.repoId}-${run.prNumber}-r${run.id}${attempt > 0 ? `-a${attempt}` : ""}`;
}

/**
 * Records a queued run (and the PR's `reviews` row if this is its first) without enqueueing it. Older non-terminal
 * runs of the PR are superseded: queued ones end at once, running ones get `cancelRequested` and stop at their
 * next stage boundary. Webhook triggers reuse an in-flight run for the same head.
 */
export async function createRun(db: Db, input: RequestReviewInput, log: Logger = rootLog): Promise<{ run: RunRow; deduped: boolean }> {
  const [repo] = await db.select({ id: repos.id }).from(repos).where(scoped(repos, input.orgId, eq(repos.id, input.repoId)));
  if (!repo) throw new ReviewRequestError(`repository ${input.repoId} not found`);

  const result = await db.transaction(async (tx) => {
    const [review] = await tx
      .insert(reviews)
      .values({ orgId: input.orgId, repoId: input.repoId, prNumber: input.prNumber, headSha: input.headSha ?? "", status: "queued" })
      .onConflictDoUpdate({ target: [reviews.repoId, reviews.prNumber], set: { updatedAt: new Date() } })
      .returning();
    if (!review || review.orgId !== input.orgId) throw new ReviewRequestError("review belongs to another org");
    await lockPrRequests(tx, review.id);

    if (input.headSha && WEBHOOK_TRIGGERS.has(input.trigger)) {
      const [same] = await tx
        .select()
        .from(reviewRuns)
        .where(
          scoped(
            reviewRuns,
            input.orgId,
            eq(reviewRuns.reviewId, review.id),
            eq(reviewRuns.headSha, input.headSha),
            eq(reviewRuns.cancelRequested, false),
            inArray(reviewRuns.status, ACTIVE_STATUSES),
          ),
        )
        .orderBy(desc(reviewRuns.id))
        .limit(1);
      if (same) return { run: same, deduped: true, superseded: [] as RunRow[] };
    }

    const [created] = await tx
      .insert(reviewRuns)
      .values({
        orgId: input.orgId,
        repoId: input.repoId,
        reviewId: review.id,
        prNumber: input.prNumber,
        headSha: input.headSha ?? null,
        trigger: input.trigger,
        mode: input.mode ?? null,
        focus: input.focus ?? null,
        full: input.full ?? false,
        requestedBy: input.requestedBy ?? null,
        stageTimings: { queued: { startedAt: new Date().toISOString() } },
      })
      .returning();
    const [run] = await tx
      .update(reviewRuns)
      .set({ jobId: runJobId(created!) })
      .where(scoped(reviewRuns, input.orgId, eq(reviewRuns.id, created!.id)))
      .returning();
    await tx
      .update(reviews)
      .set({ lastRunId: run!.id, status: "queued", ...(input.headSha ? { headSha: input.headSha } : {}) })
      .where(scoped(reviews, input.orgId, eq(reviews.id, review.id)));

    const older = await tx
      .update(reviewRuns)
      .set({ cancelRequested: true })
      .where(
        scoped(reviewRuns, input.orgId, eq(reviewRuns.reviewId, review.id), lt(reviewRuns.id, run!.id), inArray(reviewRuns.status, ACTIVE_STATUSES)),
      )
      .returning();
    for (const o of older.filter((o) => o.status === "queued")) {
      await transition(tx, { orgId: o.orgId, runId: o.id }, "superseded", { statusReason: `superseded by run ${run!.id}` }, { log });
    }
    return { run: run!, deduped: false, superseded: older };
  });
  const logger = runLogger(result.run, log);
  if (result.deduped) logger.info("review request deduped against an in-flight run", { trigger: input.trigger, headSha: input.headSha });
  else {
    logger.info("review run requested", {
      trigger: input.trigger,
      headSha: input.headSha,
      requestedBy: input.requestedBy,
      ...(result.superseded.length ? { supersedes: result.superseded.map((o) => o.id) } : {}),
    });
  }
  return { run: result.run, deduped: result.deduped };
}

/**
 * Requests a review (R6.6): records a queued run and enqueues `review-pr` for it under a job id derived from the
 * run id. Push-triggered runs (`synchronize`) are debounced by REVIEW_DEBOUNCE_MS; if another push lands in the
 * meantime its run supersedes this one, so a burst of pushes is reviewed once. A webhook request for a head that
 * already has a run in flight returns that run (and re-adds its job, which the queue dedupes). With `gate`, a
 * webhook request the settings turn away returns {@link GatedRequest} without recording a run.
 */
export async function requestReview(deps: RequestReviewDeps, input: RequestReviewInput & { gate: RequestGate }): Promise<RequestedRun | GatedRequest>;
export async function requestReview(deps: RequestReviewDeps, input: RequestReviewInput): Promise<RequestedRun>;
export async function requestReview(deps: RequestReviewDeps, input: RequestReviewInput & { gate?: RequestGate }): Promise<RequestedRun | GatedRequest> {
  if (input.gate) {
    const reason = reviewGate(input.gate.settings, { trigger: input.trigger, draft: input.gate.draft, baseRef: input.gate.baseRef, headRef: input.gate.headRef });
    if (reason) {
      (deps.log ?? rootLog).info("review request gated by settings", { orgId: input.orgId, repoId: input.repoId, prNumber: input.prNumber, trigger: input.trigger, reason });
      return { gated: true, reason };
    }
  }
  const { run, deduped } = await createRun(deps.db, input, deps.log);
  const jobId = run.jobId ?? runJobId(run);
  if (!deduped || run.status === "queued") {
    const delay = input.trigger === "synchronize" ? (deps.debounceMs ?? pipelineEnv().REVIEW_DEBOUNCE_MS) : undefined;
    await deps.queue.add(
      "review-pr",
      {
        runId: run.id,
        orgId: run.orgId,
        repoId: run.repoId,
        prNumber: run.prNumber,
        ...(run.headSha ? { headSha: run.headSha } : {}),
        trigger: input.trigger,
        ...(input.meta ? { meta: input.meta } : {}),
      },
      { jobId, ...(delay ? { delay } : {}) },
    );
  }
  return { runId: run.id, reviewId: run.reviewId, jobId, deduped };
}

export type CancelOutcome =
  | { status: "cancelled"; runId: number }
  | { status: "cancel_requested"; runId: number }
  | { status: "already_finished"; runId: number; runStatus: RunRow["status"] }
  | { status: "not_found"; runId: number };

/**
 * Cancels a run (R6.16). A queued run ends `cancelled` at once; a running one gets `cancelRequested` and stops at
 * its next stage boundary (in-flight model calls are aborted by the worker's cancellation poll) and before
 * publishing. Finished runs are left alone.
 */
export async function cancelReview(db: Db, orgId: string, runId: number, userId: string, log: Logger = rootLog): Promise<CancelOutcome> {
  const run = await getRun(db, { orgId, runId });
  if (!run) return { status: "not_found", runId };
  if (isTerminal(run.status)) return { status: "already_finished", runId, runStatus: run.status };
  const reason = `cancelled by ${userId}`;
  if (run.status === "queued") {
    try {
      await transition(db, { orgId, runId }, "cancelled", { cancelRequested: true, statusReason: reason }, { log });
      await db
        .update(reviews)
        .set({ status: "cancelled" })
        .where(scoped(reviews, orgId, eq(reviews.id, run.reviewId), eq(reviews.lastRunId, runId)));
      return { status: "cancelled", runId };
    } catch {
      // The worker claimed it in the meantime: fall through and ask the running job to stop.
    }
  }
  const updated = await db
    .update(reviewRuns)
    .set({ cancelRequested: true, statusReason: reason })
    .where(scoped(reviewRuns, orgId, eq(reviewRuns.id, runId), inArray(reviewRuns.status, ACTIVE_STATUSES)))
    .returning({ id: reviewRuns.id });
  if (!updated.length) {
    const now = await getRun(db, { orgId, runId });
    return { status: "already_finished", runId, runStatus: now?.status ?? "cancelled" };
  }
  runLogger(run, log).info("review run cancellation requested", { requestedBy: userId });
  return { status: "cancel_requested", runId };
}

/** True when a newer run of the same PR exists that was not cancelled by a person (this run is obsolete). */
export async function hasNewerRun(db: Db, run: Pick<RunRow, "id" | "orgId" | "reviewId">): Promise<boolean> {
  const [row] = await db
    .select({ id: reviewRuns.id })
    .from(reviewRuns)
    .where(
      scoped(
        reviewRuns,
        run.orgId,
        eq(reviewRuns.reviewId, run.reviewId),
        gt(reviewRuns.id, run.id),
        sql`${reviewRuns.status} <> 'cancelled'`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The latest runs of a PR review, newest first. */
export async function listRuns(db: Db, orgId: string, reviewId: number, limit = 20): Promise<RunRow[]> {
  return db
    .select()
    .from(reviewRuns)
    .where(scoped(reviewRuns, orgId, eq(reviewRuns.reviewId, reviewId)))
    .orderBy(desc(reviewRuns.id))
    .limit(limit);
}
