/** Index job rows (R6.3): lifecycle transitions for the indexer and tenant-scoped reads for the dashboard and API. */
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
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

// ---- transitions used by the indexer -----------------------------------------------------------------------------

export async function markJobRunning(db: Db, id: number, input: { kind: IndexKind; fromSha: string | null }): Promise<IndexJob> {
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
    .where(eq(indexJobs.id, id))
    .returning();
  return row!;
}

/** Writes progress; returns false when the job was cancelled meanwhile. */
export async function writeJobProgress(db: Db, id: number, progress: IndexProgress, extra: { toSha?: string } = {}): Promise<boolean> {
  const rows = await db
    .update(indexJobs)
    .set({ progress, ...extra })
    .where(and(eq(indexJobs.id, id), eq(indexJobs.status, "running")))
    .returning({ id: indexJobs.id });
  return rows.length > 0;
}

export async function finishJob(
  db: Db,
  id: number,
  input: {
    status: "completed" | "failed";
    progress?: IndexProgress;
    changedFiles?: string[];
    error?: string | null;
    toSha?: string | null;
    /** Count an attempt that failed before the run started (e.g. the repository lock was busy). */
    countAttempt?: boolean;
  },
) {
  await db
    .update(indexJobs)
    .set({
      status: input.status,
      ...(input.countAttempt ? { attempts: sql`${indexJobs.attempts} + 1` } : {}),
      finishedAt: new Date(),
      error: input.error ?? null,
      ...(input.progress ? { progress: input.progress } : {}),
      ...(input.changedFiles ? { changedFiles: input.changedFiles.slice(0, MAX_CHANGED_FILES) } : {}),
      ...(input.toSha ? { toSha: input.toSha } : {}),
    })
    .where(and(eq(indexJobs.id, id), inArray(indexJobs.status, ["running", "queued"])));
}
