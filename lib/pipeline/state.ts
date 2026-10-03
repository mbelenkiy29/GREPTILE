/**
 * The review run state machine (R6.6). Every run moves forward through
 *
 *   queued → ingesting → retrieving_context → reviewing → verifying → summarizing → publishing → completed
 *
 * and may end early as failed, cancelled, superseded, or skipped. The engine drives the middle stages through its
 * `onStage` hook and may skip a stage (e.g. nothing to verify); the pipeline adds queued, publishing, and the
 * terminal states. A run that was abandoned mid-way (worker crash) is put back to `queued` by restart recovery.
 * Terminal states are final.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { reviewRuns, type StageTiming } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import { log as rootLog, type Logger } from "@/lib/log";

export const RUN_STATUSES = reviewRuns.status.enumValues;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunRow = typeof reviewRuns.$inferSelect;

/** The forward path; a run may skip ahead along it but never move back (except a restart to `queued`). */
export const STAGE_ORDER = [
  "queued",
  "ingesting",
  "retrieving_context",
  "reviewing",
  "verifying",
  "summarizing",
  "publishing",
  "completed",
] as const satisfies readonly RunStatus[];

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "superseded", "skipped"] as const satisfies readonly RunStatus[];
export const ACTIVE_STATUSES = RUN_STATUSES.filter((s) => !(TERMINAL_STATUSES as readonly string[]).includes(s));

export function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Whether `from → to` is a legal transition. Re-entering the current non-terminal state is a no-op, not a move. */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (isTerminal(from)) return false;
  if (to === "failed" || to === "cancelled" || to === "superseded") return true;
  // Skipping happens while deciding whether to review at all (settings gates, PR closed, repo disabled).
  if (to === "skipped") return from === "queued" || from === "ingesting";
  // Restart: an abandoned or retried run goes back to the queue.
  if (to === "queued") return from !== "queued";
  const i = STAGE_ORDER.indexOf(from as (typeof STAGE_ORDER)[number]);
  const j = STAGE_ORDER.indexOf(to as (typeof STAGE_ORDER)[number]);
  if (i < 0 || j < 0) return false;
  // Completion is only reachable through publishing, so nothing completes without the publish guard.
  if (to === "completed") return from === "publishing";
  return j > i;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly runId: number,
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`review run ${runId}: illegal transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: number) {
    super(`review run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

export type RunPatch = Partial<
  Pick<
    typeof reviewRuns.$inferInsert,
    | "statusReason"
    | "error"
    | "headSha"
    | "baseSha"
    | "sinceSha"
    | "attempts"
    | "jobId"
    | "cancelRequested"
    | "classification"
    | "contextStats"
    | "summary"
    | "models"
    | "filesReviewed"
    | "findingsPublished"
    | "findingsRejected"
    | "findingsResolved"
    | "inputTokens"
    | "outputTokens"
    | "costUsd"
    | "credits"
  >
>;

export interface RunRef {
  orgId: string;
  runId: number;
}

/** Correlation ids for every log line about a run (R6.21). */
export function runLogger(run: Pick<RunRow, "id" | "orgId" | "repoId" | "reviewId" | "prNumber">, base: Logger = rootLog): Logger {
  return base.child({ reviewRunId: run.id, orgId: run.orgId, repoId: run.repoId, reviewId: run.reviewId, prNumber: run.prNumber });
}

function closeTiming(timings: Record<string, StageTiming>, stage: string, now: Date): Record<string, StageTiming> {
  const open = timings[stage];
  if (!open || open.durationMs !== undefined) return timings;
  return { ...timings, [stage]: { ...open, durationMs: Math.max(0, now.getTime() - Date.parse(open.startedAt)) } };
}

/**
 * Moves a run to `to` atomically (row lock): checks legality against the current status, closes the timing of the
 * state being left, opens the new one, refreshes the heartbeat, and applies `patch`. Terminal states stamp
 * `finishedAt`; entering `ingesting` stamps `startedAt`. Re-entering the current state only refreshes the heartbeat.
 * Throws {@link IllegalTransitionError} for an illegal or post-terminal move, or when `opts.from` does not match.
 */
export async function transition(
  db: Db,
  ref: RunRef,
  to: RunStatus,
  patch: RunPatch = {},
  opts: {
    now?: Date;
    log?: Logger;
    /** Only move when the run is currently in this state (claiming a queued run). */
    from?: RunStatus;
    /** Heartbeat to record instead of `now`, e.g. a run deferred until a rate limit resets is not stale meanwhile. */
    heartbeatAt?: Date;
  } = {},
): Promise<RunRow> {
  const now = opts.now ?? new Date();
  const heartbeatAt = opts.heartbeatAt ?? now;
  const { run, from } = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(reviewRuns)
      .where(scoped(reviewRuns, ref.orgId, eq(reviewRuns.id, ref.runId)))
      .for("update");
    if (!current) throw new RunNotFoundError(ref.runId);
    if (opts.from !== undefined && current.status !== opts.from) throw new IllegalTransitionError(ref.runId, current.status, to);
    if (current.status === to && !isTerminal(to)) {
      const [same] = await tx
        .update(reviewRuns)
        .set({ ...patch, heartbeatAt })
        .where(scoped(reviewRuns, ref.orgId, eq(reviewRuns.id, ref.runId)))
        .returning();
      return { run: same!, from: current.status };
    }
    if (!canTransition(current.status, to)) throw new IllegalTransitionError(ref.runId, current.status, to);
    let timings = closeTiming(current.stageTimings, current.status, now);
    timings = { ...timings, [to]: { startedAt: now.toISOString(), ...(isTerminal(to) ? { durationMs: 0 } : {}) } };
    const [updated] = await tx
      .update(reviewRuns)
      .set({
        ...patch,
        status: to,
        stageTimings: timings,
        heartbeatAt,
        ...(to === "ingesting" && !current.startedAt ? { startedAt: now } : {}),
        ...(isTerminal(to) ? { finishedAt: now } : {}),
        ...(to === "queued" ? { finishedAt: null } : {}),
      })
      .where(scoped(reviewRuns, ref.orgId, eq(reviewRuns.id, ref.runId)))
      .returning();
    return { run: updated!, from: current.status };
  });
  if (from !== to) {
    const fields = { from, to, ...(patch.statusReason ? { reason: patch.statusReason } : {}), ...(patch.error ? { error: patch.error } : {}) };
    const logger = runLogger(run, opts.log);
    (to === "failed" ? logger.warn : logger.info)("review run transition", fields);
  }
  return run;
}

/** Refreshes a running run's heartbeat (restart recovery treats a stale heartbeat as an abandoned run). */
export async function touchHeartbeat(db: Db, ref: RunRef, now: Date = new Date()): Promise<void> {
  await db
    .update(reviewRuns)
    .set({ heartbeatAt: now })
    .where(scoped(reviewRuns, ref.orgId, eq(reviewRuns.id, ref.runId)));
}

export async function getRun(db: Db, ref: RunRef): Promise<RunRow | undefined> {
  const [row] = await db.select().from(reviewRuns).where(scoped(reviewRuns, ref.orgId, eq(reviewRuns.id, ref.runId)));
  return row;
}
