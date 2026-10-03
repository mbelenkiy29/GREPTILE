/** Index job rows (R6.3): lifecycle transitions for the indexer and tenant-scoped reads for the dashboard and API. */
import { count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import type { JobQueue } from "@/lib/jobs/types";
import { EMPTY_INDEX_PROGRESS, indexJobs, indexJobStatus, indexJobTrigger, repos, type IndexProgress } from "@/lib/db/schema";

export type IndexJob = typeof indexJobs.$inferSelect;
export type IndexJobStatus = (typeof indexJobStatus.enumValues)[number];
export type IndexTrigger = (typeof indexJobTrigger.enumValues)[number];
export type IndexKind = "full" | "incremental";

export const MAX_CHANGED_FILES = 500;

/** Queues a tracked index run for a repository the org owns. Pass the returned id as `indexJobId` to the job. */
export async function createIndexJob(
  db: Db,
  input: { orgId: string; repoId: number; kind: IndexKind; trigger: IndexTrigger; toSha?: string | null; queueJobId?: string | null },
): Promise<IndexJob> {
  const [repo] = await db.select({ id: repos.id }).from(repos).where(scoped(repos, input.orgId, eq(repos.id, input.repoId)));
  if (!repo) throw new Error(`repo ${input.repoId} not found for org ${input.orgId}`);
  const [row] = await db
    .insert(indexJobs)
    .values({
      orgId: input.orgId,
      repoId: input.repoId,
      kind: input.kind,
      trigger: input.trigger,
      toSha: input.toSha ?? null,
      queueJobId: input.queueJobId ?? null,
    })
    .returning();
  return row!;
}

export async function getIndexJob(db: Db, orgId: string, repoId: number, id: number): Promise<IndexJob | null> {
  const [row] = await db.select().from(indexJobs).where(scoped(indexJobs, orgId, eq(indexJobs.repoId, repoId), eq(indexJobs.id, id)));
  return row ?? null;
}

export async function findIndexJobByQueueId(db: Db, orgId: string, repoId: number, queueJobId: string): Promise<IndexJob | null> {
  const [row] = await db
    .select()
    .from(indexJobs)
    .where(scoped(indexJobs, orgId, eq(indexJobs.repoId, repoId), eq(indexJobs.queueJobId, queueJobId)))
    .orderBy(desc(indexJobs.id))
    .limit(1);
  return row ?? null;
}

/** Index runs of a repository, newest first. */
export async function listIndexJobs(
  db: Db,
  orgId: string,
  repoId: number,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ jobs: IndexJob[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 20)));
  const where = scoped(indexJobs, orgId, eq(indexJobs.repoId, repoId));
  const [jobs, [total]] = await Promise.all([
    db
      .select()
      .from(indexJobs)
      .where(where)
      .orderBy(desc(indexJobs.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(indexJobs).where(where),
  ]);
  return { jobs, total: total?.n ?? 0, page, pageSize };
}

export interface IndexStatus {
  repoId: number;
  indexStatus: string;
  indexedSha: string | null;
  indexedAt: Date | null;
  indexError: string | null;
  fileCount: number;
  symbolCount: number;
  languages: Record<string, number>;
  /** The queued or running job, if any. */
  current: IndexJob | null;
  /** The most recent finished job (completed, failed, or cancelled). */
  last: IndexJob | null;
}

/** Index state of one repository for the dashboard, or null when the org does not own it. */
export async function getIndexStatus(db: Db, orgId: string, repoId: number): Promise<IndexStatus | null> {
  const [repo] = await db.select().from(repos).where(scoped(repos, orgId, eq(repos.id, repoId)));
  if (!repo) return null;
  const latest = (statuses: IndexJobStatus[]) =>
    db
      .select()
      .from(indexJobs)
      .where(scoped(indexJobs, orgId, eq(indexJobs.repoId, repoId), inArray(indexJobs.status, statuses)))
      .orderBy(desc(indexJobs.id))
      .limit(1);
  const [[current], [last]] = await Promise.all([latest(["running", "queued"]), latest(["completed", "failed", "cancelled"])]);
  return {
    repoId: repo.id,
    indexStatus: repo.indexStatus,
    indexedSha: repo.indexedSha,
    indexedAt: repo.indexedAt,
    indexError: repo.indexError,
    fileCount: repo.fileCount,
    symbolCount: repo.symbolCount,
    languages: repo.languages,
    current: current ?? null,
    last: last ?? null,
  };
}

/**
 * Cancels a queued or running job. A queued job never starts; a running one stops at its next progress checkpoint,
 * keeping the files it already re-indexed (they are consistent per file) and leaving `indexedSha` unchanged.
 */
export async function cancelIndexJob(db: Db, orgId: string, repoId: number, id: number): Promise<boolean> {
  const rows = await db
    .update(indexJobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(scoped(indexJobs, orgId, eq(indexJobs.repoId, repoId), eq(indexJobs.id, id), inArray(indexJobs.status, ["queued", "running"])))
    .returning({ id: indexJobs.id });
  return rows.length > 0;
}

/**
 * Queues a tracked index run a person asked for (dashboard re-index, onboarding retry): records the `index_jobs`
 * row and enqueues `index-repo` for it. If the queue refuses, the row is cancelled so no tracked run waits forever.
 * Returns undefined when the repository is not the org's.
 */
export async function queueManualIndex(
  deps: { db: Db; queue: JobQueue },
  input: { orgId: string; repoId: number; kind: IndexKind; requestedBy: string },
): Promise<IndexJob | undefined> {
  const [repo] = await deps.db.select({ id: repos.id }).from(repos).where(scoped(repos, input.orgId, eq(repos.id, input.repoId)));
  if (!repo) return undefined;
  const job = await createIndexJob(deps.db, { orgId: input.orgId, repoId: repo.id, kind: input.kind, trigger: "manual" });
  try {
    await deps.queue.add(
      "index-repo",
      { orgId: input.orgId, repoId: repo.id, mode: input.kind, trigger: "manual", indexJobId: job.id, meta: { requestedBy: input.requestedBy } },
      { jobId: `index-${repo.id}-manual-${job.id}` },
    );
  } catch (err) {
    await cancelIndexJob(deps.db, input.orgId, repo.id, job.id);
    throw err;
  }
  return job;
}

// ---- transitions used by the indexer -----------------------------------------------------------------------------

/** The repository a transition applies to; every transition is filtered by it as well as by the job id. */
export interface JobScope {
  orgId: string;
  repoId: number;
}

function jobWhere(scope: JobScope, id: number, statuses: IndexJobStatus[]) {
  return scoped(indexJobs, scope.orgId, eq(indexJobs.repoId, scope.repoId), eq(indexJobs.id, id), inArray(indexJobs.status, statuses));
}

/** Error shown on a job that is queued again because another run holds the repository's lock. */
export const WAITING_FOR_LOCK = "waiting for repository lock";

/**
 * Starts a run of a job: counts the attempt and resets its progress. Returns null when the job was cancelled (or has
 * already completed) meanwhile, so a cancel issued while the run waited for the lock is never overwritten.
 */
export async function markJobRunning(db: Db, scope: JobScope, id: number, input: { kind: IndexKind; fromSha: string | null }): Promise<IndexJob | null> {
  const [row] = await db
    .update(indexJobs)
    .set({
      status: "running",
      kind: input.kind,
      fromSha: input.fromSha,
      attempts: sql`${indexJobs.attempts} + 1`,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      progress: { ...EMPTY_INDEX_PROGRESS, phase: "checkout" },
    })
    .where(jobWhere(scope, id, ["queued", "failed", "running"]))
    .returning();
  return row ?? null;
}

/**
 * Marks jobs of the repository still recorded as running, other than `exceptId`, as failed. Called while holding the
 * repository's index lock, when no other run can be active: such rows were left by a worker that stopped mid-run.
 */
export async function failInterruptedJobs(db: Db, scope: JobScope, exceptId: number): Promise<number> {
  const rows = await db
    .update(indexJobs)
    .set({ status: "failed", error: "interrupted: the worker running this job stopped before it finished", finishedAt: new Date() })
    .where(scoped(indexJobs, scope.orgId, eq(indexJobs.repoId, scope.repoId), eq(indexJobs.status, "running"), ne(indexJobs.id, exceptId)))
    .returning({ id: indexJobs.id });
  return rows.length;
}

/**
 * Puts a job back in the queue while another run holds the repository's lock (it stays cancellable meanwhile). A row
 * that is running is left alone: it belongs to another delivery of the same queue job that holds the lock.
 */
export async function markJobWaitingForLock(db: Db, scope: JobScope, id: number) {
  await db
    .update(indexJobs)
    .set({ status: "queued", error: WAITING_FOR_LOCK, finishedAt: null })
    .where(jobWhere(scope, id, ["queued", "failed"]));
}

/** Writes progress; returns false when the job was cancelled meanwhile. */
export async function writeJobProgress(db: Db, scope: JobScope, id: number, progress: IndexProgress, extra: { toSha?: string } = {}): Promise<boolean> {
  const rows = await db
    .update(indexJobs)
    .set({ progress, ...extra })
    .where(jobWhere(scope, id, ["running"]))
    .returning({ id: indexJobs.id });
  return rows.length > 0;
}

export async function finishJob(
  db: Db,
  scope: JobScope,
  id: number,
  input: {
    status: "completed" | "failed";
    progress?: IndexProgress;
    changedFiles?: string[];
    error?: string | null;
    toSha?: string | null;
  },
) {
  await db
    .update(indexJobs)
    .set({
      status: input.status,
      finishedAt: new Date(),
      error: input.error ?? null,
      ...(input.progress ? { progress: input.progress } : {}),
      ...(input.changedFiles ? { changedFiles: input.changedFiles.slice(0, MAX_CHANGED_FILES) } : {}),
      ...(input.toSha ? { toSha: input.toSha } : {}),
    })
    .where(jobWhere(scope, id, ["running", "queued"]));
}
