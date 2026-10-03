/**
 * A review run's lifecycle as a timeline (R6.6): every stage of the state machine with when it started, how long it
 * took, and whether it ran, was skipped, is running, or was where the run stopped.
 */
import type { StageTiming } from "@/lib/db/schema";

export const LIFECYCLE_STAGES = ["queued", "ingesting", "retrieving_context", "reviewing", "verifying", "summarizing", "publishing"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "superseded", "skipped"] as const;

export const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  ingesting: "Ingesting pull request",
  retrieving_context: "Retrieving context",
  reviewing: "Reviewing",
  verifying: "Verifying findings",
  summarizing: "Summarizing",
  publishing: "Publishing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded",
  skipped: "Skipped",
};

/**
 * - done: the stage ran and finished; current: the run is in it now; interrupted: the run ended (failed, cancelled,
 *   superseded, skipped) while in it; skipped: the run moved past it without entering it; pending: not reached yet.
 * The final step is the outcome: ok (completed), failed, stopped (cancelled / superseded / skipped), or pending.
 */
export type StepState = "done" | "current" | "interrupted" | "skipped" | "pending" | "ok" | "failed" | "stopped";

export interface LifecycleStep {
  stage: string;
  label: string;
  state: StepState;
  startedAt: Date | null;
  durationMs: number | null;
  /** Why the run ended here (outcome step of a failed / cancelled / superseded / skipped run). */
  detail: string | null;
}

export interface LifecycleRun {
  status: string;
  statusReason: string | null;
  error: string | null;
  stageTimings: Record<string, StageTiming>;
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function runLifecycle(run: LifecycleRun, now: Date = new Date()): LifecycleStep[] {
  const timings = run.stageTimings ?? {};
  const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status);
  // Furthest stage the run entered (stage timings are only written when a stage is entered).
  let reached = -1;
  LIFECYCLE_STAGES.forEach((s, i) => {
    if (timings[s]) reached = i;
  });
  const current = (LIFECYCLE_STAGES as readonly string[]).indexOf(run.status);
  if (current > reached) reached = current;

  const steps: LifecycleStep[] = LIFECYCLE_STAGES.map((stage, i) => {
    const t = timings[stage];
    const startedAt = parseDate(t?.startedAt);
    let state: StepState;
    let durationMs = t?.durationMs ?? null;
    if (run.status === stage) {
      state = "current";
      if (startedAt && durationMs === null) durationMs = Math.max(0, now.getTime() - startedAt.getTime());
    } else if (t) {
      state = terminal && run.status !== "completed" && i === reached ? "interrupted" : "done";
    } else {
      state = i < reached || (terminal && run.status === "completed") ? "skipped" : "pending";
    }
    return { stage, label: STAGE_LABEL[stage] ?? stage, state, startedAt, durationMs, detail: null };
  });

  const outcomeTiming = terminal ? timings[run.status] : undefined;
  const outcome: LifecycleStep = terminal
    ? {
        stage: run.status,
        label: STAGE_LABEL[run.status] ?? run.status,
        state: run.status === "completed" ? "ok" : run.status === "failed" ? "failed" : "stopped",
        startedAt: parseDate(outcomeTiming?.startedAt),
        durationMs: null,
        detail: run.status === "completed" ? null : [run.statusReason, run.error].filter((x): x is string => Boolean(x)).join(" — ") || null,
      }
    : { stage: "completed", label: STAGE_LABEL.completed!, state: "pending", startedAt: null, durationMs: null, detail: null };
  return [...steps, outcome];
}

/** Wall-clock duration of a run (start to finish, or to now while active), or null if it never started. */
export function runDurationMs(run: { startedAt: Date | null; finishedAt: Date | null; queuedAt?: Date }, now: Date = new Date()): number | null {
  if (!run.startedAt) return null;
  return Math.max(0, (run.finishedAt ?? now).getTime() - run.startedAt.getTime());
}
