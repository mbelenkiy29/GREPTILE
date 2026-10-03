/**
 * Overview metrics for the dashboard home (R6.13). Every function is tenant-scoped by `orgId`; the page composes
 * them through {@link getOverview}.
 */
import { count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { findings, indexJobs, repos, reviewRuns, reviews, usageEvents, type IndexProgress } from "@/lib/db/schema";
import { SEVERITIES, type Severity } from "@/lib/engine/types";
import { feedbackSummary } from "./feedback";
import { listReviews, type ReviewListItem } from "./reviews";
import { scoped } from "./tenant";

export interface OverviewCounts {
  /** Connected repositories (all), and those with reviews on and not archived. */
  repos: number;
  activeRepos: number;
  /** Pull requests with at least one completed review. */
  prsReviewed: number;
  /** Published findings (posted, or held back by the comment limit). */
  findingsCaught: number;
}

export async function overviewCounts(db: Db, orgId: string): Promise<OverviewCounts> {
  const [[repoRow], [prRow], [findingRow]] = await Promise.all([
    db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${repos.enabled} and not ${repos.archived})`.mapWith(Number),
      })
      .from(repos)
      .where(scoped(repos, orgId)),
    db
      .select({ n: count() })
      .from(reviews)
      .where(scoped(reviews, orgId, sql`exists (select 1 from ${reviewRuns} where ${reviewRuns.reviewId} = ${reviews.id} and ${reviewRuns.orgId} = ${orgId} and ${reviewRuns.status} = 'completed')`)),
    db
      .select({ n: count() })
      .from(findings)
      .where(scoped(findings, orgId, eq(findings.visibility, "published"))),
  ]);
  return {
    repos: Number(repoRow?.total ?? 0),
    activeRepos: Number(repoRow?.active ?? 0),
    prsReviewed: Number(prRow?.n ?? 0),
    findingsCaught: Number(findingRow?.n ?? 0),
  };
}

/** Published findings per severity (every severity present, zero-filled), most severe first. */
export async function findingsBySeverity(db: Db, orgId: string): Promise<{ severity: Severity; count: number }[]> {
  const rows = await db
    .select({ severity: findings.severity, n: count() })
    .from(findings)
    .where(scoped(findings, orgId, eq(findings.visibility, "published")))
    .groupBy(findings.severity);
  return SEVERITIES.map((severity) => ({ severity, count: Number(rows.find((r) => r.severity === severity)?.n ?? 0) }));
}

export interface FeedbackAcceptance {
  /** Comments whose reactions and replies were net positive. */
  useful: number;
  /** Comments whose reactions and replies were net negative. */
  notUseful: number;
  /** Findings a person marked as a false positive. */
  falsePositive: number;
  /** useful / (useful + notUseful + falsePositive), or null with no feedback yet. */
  acceptanceRate: number | null;
}

/**
 * How useful published comments were judged to be. Reads the reactions and replies recorded on OpenReview's inline
 * comments (`comment_feedback`, R2.4) and findings marked false positive (R6.9). When per-finding feedback
 * (`finding_feedback`) exists, this is the one function to switch over to it.
 */
export async function feedbackAcceptance(db: Db, orgId: string): Promise<FeedbackAcceptance> {
  // Every feedback source (dashboard, API, GitHub reactions, replies, and commands) lands in finding_feedback (R6.10).
  const { total } = await feedbackSummary(db, orgId);
  return { useful: total.useful, notUseful: total.notUseful, falsePositive: total.falsePositive, acceptanceRate: total.acceptanceRate };
}

export interface DayCount {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  runs: number;
  completed: number;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Review runs requested per UTC day over the last `days` days (oldest first, zero-filled, today included). */
export async function reviewActivity(db: Db, orgId: string, opts: { days?: number; now?: Date } = {}): Promise<DayCount[]> {
  const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 366);
  const now = opts.now ?? new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const day = sql<string>`to_char(${reviewRuns.queuedAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      runs: count(),
      completed: sql<number>`count(*) filter (where ${reviewRuns.status} = 'completed')`.mapWith(Number),
    })
    .from(reviewRuns)
    .where(scoped(reviewRuns, orgId, gte(reviewRuns.queuedAt, start)))
    .groupBy(day);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => {
    const d = utcDay(new Date(start.getTime() + i * 86_400_000));
    const r = byDay.get(d);
    return { day: d, runs: Number(r?.runs ?? 0), completed: Number(r?.completed ?? 0) };
  });
}

export interface MonthUsage {
  /** First instant of the current UTC month. */
  since: Date;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD of priced usage (unpriced usage is not counted). */
  costUsd: number;
  credits: number;
}

/** Metered usage this calendar month (UTC), from `usage_events` (R6.16). */
export async function usageThisMonth(db: Db, orgId: string, now: Date = new Date()): Promise<MonthUsage> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({
      reviews: sql<number>`count(*) filter (where ${usageEvents.kind} = 'review')`.mapWith(Number),
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`.mapWith(Number),
      costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)`.mapWith(Number),
      credits: sql<number>`coalesce(sum(${usageEvents.credits}), 0)`.mapWith(Number),
    })
    .from(usageEvents)
    .where(scoped(usageEvents, orgId, gte(usageEvents.createdAt, since)));
  return {
    since,
    reviews: row?.reviews ?? 0,
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    costUsd: row?.costUsd ?? 0,
    credits: row?.credits ?? 0,
  };
}

export interface RepoIndexState {
  repoId: number;
  fullName: string;
  indexStatus: string;
  indexError: string | null;
  indexedSha: string | null;
  indexedAt: Date | null;
  /** The queued or running index job, with its live progress. */
  job: { id: number; status: string; kind: string; progress: IndexProgress; startedAt: Date | null } | null;
}

/** Every repository's index state, in-progress ones first (bounded to `limit`). */
export async function repoIndexStates(db: Db, orgId: string, limit = 8): Promise<RepoIndexState[]> {
  const rows = await db
    .select({
      repoId: repos.id,
      fullName: repos.fullName,
      indexStatus: repos.indexStatus,
      indexError: repos.indexError,
      indexedSha: repos.indexedSha,
      indexedAt: repos.indexedAt,
    })
    .from(repos)
    .where(scoped(repos, orgId))
    .orderBy(sql`case ${repos.indexStatus} when 'indexing' then 0 when 'failed' then 1 when 'pending' then 2 else 3 end`, repos.fullName)
    .limit(Math.min(Math.max(limit, 1), 100));
  const jobs = await activeIndexJobs(db, orgId, rows.map((r) => r.repoId));
  return rows.map((r) => ({ ...r, job: jobs.get(r.repoId) ?? null }));
}

/** The newest queued or running index job of each of the given repositories. */
export async function activeIndexJobs(db: Db, orgId: string, repoIds: number[]): Promise<Map<number, NonNullable<RepoIndexState["job"]>>> {
  const out = new Map<number, NonNullable<RepoIndexState["job"]>>();
  if (!repoIds.length) return out;
  const rows = await db
    .select({
      id: indexJobs.id,
      repoId: indexJobs.repoId,
      status: indexJobs.status,
      kind: indexJobs.kind,
      progress: indexJobs.progress,
      startedAt: indexJobs.startedAt,
    })
    .from(indexJobs)
    .where(scoped(indexJobs, orgId, inArray(indexJobs.repoId, repoIds), inArray(indexJobs.status, ["queued", "running"])))
    .orderBy(desc(indexJobs.id));
  for (const r of rows) if (!out.has(r.repoId)) out.set(r.repoId, { id: r.id, status: r.status, kind: r.kind, progress: r.progress, startedAt: r.startedAt });
  return out;
}

/** Fraction (0..1) of an index job's work done, from its phase and file counts; null when unknown. */
export function indexProgressFraction(p: IndexProgress | null | undefined): number | null {
  if (!p) return null;
  const phases = ["queued", "checkout", "scan", "parse", "embed", "graph", "finalize", "done"] as const;
  const i = phases.indexOf(p.phase);
  if (i < 0) return null;
  if (p.phase === "done") return 1;
  // Parse is where the work is; weight it by files processed.
  if (p.phase === "parse" && p.filesChanged > 0) return Math.min(0.9, 0.3 + 0.5 * Math.min(1, p.filesDone / p.filesChanged));
  return [0, 0.05, 0.15, 0.3, 0.8, 0.88, 0.95][i] ?? null;
}

export interface Overview {
  counts: OverviewCounts;
  bySeverity: { severity: Severity; count: number }[];
  feedback: FeedbackAcceptance;
  recentReviews: ReviewListItem[];
  activity: DayCount[];
  indexing: RepoIndexState[];
  usage: MonthUsage;
}

export async function getOverview(db: Db, orgId: string, now: Date = new Date()): Promise<Overview> {
  const [counts, bySeverity, feedback, recentReviews, activity, indexing, usage] = await Promise.all([
    overviewCounts(db, orgId),
    findingsBySeverity(db, orgId),
    feedbackAcceptance(db, orgId),
    listReviews(db, orgId, { limit: 5 }),
    reviewActivity(db, orgId, { days: 30, now }),
    repoIndexStates(db, orgId, 8),
    usageThisMonth(db, orgId, now),
  ]);
  return { counts, bySeverity, feedback, recentReviews, activity, indexing, usage };
}
