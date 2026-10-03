import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { agentRuns, findings, pullRequests, repos, reviewComments, reviewRuns, reviews, reviewStatus, type StageTiming } from "@/lib/db/schema";
import { SEVERITIES, type ReviewSummary, type Severity } from "@/lib/engine/types";
import { listFindings, severityRank, type FindingRow } from "./findings";
import { pageWindow, toPage, type Page, type PageOptions } from "./paginate";
import { scoped } from "./tenant";

export interface ReviewListItem {
  id: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  status: string;
  riskLevel: string | null;
  confidence: number | null;
  commentCount: number;
  creditsUsed: number;
  runs: number;
  /** Review mode of the latest run (R6.14). */
  mode: string;
  /** Published findings still open / resolved by later commits (R6.9). */
  openFindings: number;
  resolvedFindings: number;
  /** Estimated model cost of all completed runs, USD (R6.16). */
  costUsd: number;
  lastRunId: number | null;
  updatedAt: Date;
}

/** The org's reviews, most recently updated first (R1.8). */
export async function listReviews(
  db: Db,
  orgId: string,
  opts: { repoId?: number; limit?: number; offset?: number } = {},
): Promise<ReviewListItem[]> {
  return db
    .select({
      id: reviews.id,
      repoFullName: repos.fullName,
      prNumber: reviews.prNumber,
      prTitle: reviews.prTitle,
      prAuthor: reviews.prAuthor,
      status: reviews.status,
      riskLevel: reviews.riskLevel,
      confidence: reviews.confidence,
      commentCount: reviews.commentCount,
      creditsUsed: reviews.creditsUsed,
      runs: reviews.runs,
      mode: reviews.mode,
      openFindings: reviews.openFindings,
      resolvedFindings: reviews.resolvedFindings,
      costUsd: reviews.costUsd,
      lastRunId: reviews.lastRunId,
      updatedAt: reviews.updatedAt,
    })
    .from(reviews)
    .innerJoin(repos, and(eq(reviews.repoId, repos.id), eq(repos.orgId, orgId)))
    .where(scoped(reviews, orgId, opts.repoId ? eq(reviews.repoId, opts.repoId) : undefined))
    .orderBy(desc(reviews.updatedAt), desc(reviews.id))
    .limit(Math.min(opts.limit ?? 100, 500))
    .offset(opts.offset ?? 0);
}

/** One review run as the dashboard shows it: lifecycle, timings, outcome, and cost (R6.6, R6.16). */
export interface ReviewRunItem {
  id: number;
  status: string;
  statusReason: string | null;
  trigger: string;
  mode: string | null;
  focus: string | null;
  full: boolean;
  headSha: string | null;
  sinceSha: string | null;
  requestedBy: string | null;
  attempts: number;
  cancelRequested: boolean;
  stageTimings: Record<string, StageTiming>;
  filesReviewed: number;
  findingsPublished: number;
  findingsRejected: number;
  findingsResolved: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  credits: number;
  /** Model used per task or agent, as the engine reported it. */
  models: Record<string, string> | null;
  /** Structured summary the engine wrote (completed runs). */
  summary: ReviewSummary | null;
  error: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface AgentRunItem {
  id: number;
  reviewRunId: number;
  agent: string;
  status: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  candidates: number;
  accepted: number;
  error: string | null;
}

/** A review's runs, newest first (paginated). */
export async function listReviewRuns(db: Db, orgId: string, reviewId: number, opts: { limit?: number; offset?: number } = {}): Promise<ReviewRunItem[]> {
  const rows = await db
    .select({
      id: reviewRuns.id,
      status: reviewRuns.status,
      statusReason: reviewRuns.statusReason,
      trigger: reviewRuns.trigger,
      mode: reviewRuns.mode,
      focus: reviewRuns.focus,
      full: reviewRuns.full,
      headSha: reviewRuns.headSha,
      sinceSha: reviewRuns.sinceSha,
      requestedBy: reviewRuns.requestedBy,
      attempts: reviewRuns.attempts,
      cancelRequested: reviewRuns.cancelRequested,
      stageTimings: reviewRuns.stageTimings,
      filesReviewed: reviewRuns.filesReviewed,
      findingsPublished: reviewRuns.findingsPublished,
      findingsRejected: reviewRuns.findingsRejected,
      findingsResolved: reviewRuns.findingsResolved,
      inputTokens: reviewRuns.inputTokens,
      outputTokens: reviewRuns.outputTokens,
      costUsd: reviewRuns.costUsd,
      credits: reviewRuns.credits,
      models: reviewRuns.models,
      summary: reviewRuns.summary,
      error: reviewRuns.error,
      queuedAt: reviewRuns.queuedAt,
      startedAt: reviewRuns.startedAt,
      finishedAt: reviewRuns.finishedAt,
    })
    .from(reviewRuns)
    .where(scoped(reviewRuns, orgId, eq(reviewRuns.reviewId, reviewId)))
    .orderBy(desc(reviewRuns.id))
    .limit(Math.min(opts.limit ?? 20, 100))
    .offset(opts.offset ?? 0);
  return rows.map((r) => ({ ...r, summary: parseSummary(r.summary) }));
}

const summarySchema = z.object({
  overview: z.string().catch(""),
  whatChanged: z.array(z.string()).catch([]),
  affectedAreas: z.array(z.string()).catch([]),
  riskLevel: z.enum(["low", "medium", "high"]).catch("medium"),
  riskRationale: z.string().catch(""),
  confidence: z.number().int().min(1).max(5).catch(3),
  architectureImpact: z.string().nullable().catch(null),
  relevantTests: z.array(z.object({ path: z.string(), note: z.string() })).catch([]),
  diagram: z.string().nullable().catch(null),
});

/** A run's stored summary, shape-checked (older rows or partial writes become null or get defaults). */
export function parseSummary(value: unknown): ReviewSummary | null {
  if (!value || typeof value !== "object") return null;
  const parsed = summarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The specialized agents' work in one run (R6.7). */
export async function listAgentRuns(db: Db, orgId: string, reviewRunId: number): Promise<AgentRunItem[]> {
  return db
    .select({
      id: agentRuns.id,
      reviewRunId: agentRuns.reviewRunId,
      agent: agentRuns.agent,
      status: agentRuns.status,
      model: agentRuns.model,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      costUsd: agentRuns.costUsd,
      latencyMs: agentRuns.latencyMs,
      candidates: agentRuns.candidates,
      accepted: agentRuns.accepted,
      error: agentRuns.error,
    })
    .from(agentRuns)
    .where(scoped(agentRuns, orgId, eq(agentRuns.reviewRunId, reviewRunId)))
    .orderBy(agentRuns.id);
}

export interface ReviewDetail extends ReviewListItem {
  headSha: string;
  /** The tracked pull request (R6.6), once a run has ingested it. */
  pullRequest: {
    url: string | null;
    state: string;
    draft: boolean;
    baseRef: string;
    headRef: string;
    body: string;
  } | null;
  summary: string | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: Date;
  comments: {
    id: number;
    path: string;
    line: number;
    severity: string;
    category: string;
    title: string;
    body: string;
    externalId: number | null;
    headSha: string;
  }[];
  /** Latest runs, newest first. */
  runHistory: ReviewRunItem[];
  /** Agent runs of the latest run (or of `opts.runId`). */
  agentRuns: AgentRunItem[];
  /** Findings that were posted (or held back by the comment limit), newest first. */
  findings: { items: FindingRow[]; total: number };
  /** Candidates the engine rejected, with the reason (in `verification`), newest first. */
  rejected: { items: FindingRow[]; total: number };
}

export interface ReviewDetailOptions {
  runsLimit?: number;
  runId?: number;
  findingsLimit?: number;
  findingsOffset?: number;
  rejectedLimit?: number;
  rejectedOffset?: number;
}

export async function getReviewDetail(db: Db, orgId: string, reviewId: number, opts: ReviewDetailOptions = {}): Promise<ReviewDetail | undefined> {
  const [row] = await db
    .select({
      review: reviews,
      repoFullName: repos.fullName,
      pr: {
        url: pullRequests.url,
        state: pullRequests.state,
        draft: pullRequests.draft,
        baseRef: pullRequests.baseRef,
        headRef: pullRequests.headRef,
        body: pullRequests.body,
      },
    })
    .from(reviews)
    .innerJoin(repos, and(eq(reviews.repoId, repos.id), eq(repos.orgId, orgId)))
    .leftJoin(pullRequests, and(eq(pullRequests.id, reviews.pullRequestId), eq(pullRequests.orgId, orgId)))
    .where(scoped(reviews, orgId, eq(reviews.id, reviewId)));
  if (!row) return undefined;
  const r = row.review;
  const comments = await db
    .select({
      id: reviewComments.id,
      path: reviewComments.path,
      line: reviewComments.line,
      severity: reviewComments.severity,
      category: reviewComments.category,
      title: reviewComments.title,
      body: reviewComments.body,
      externalId: reviewComments.externalId,
      headSha: reviewComments.headSha,
    })
    .from(reviewComments)
    .where(scoped(reviewComments, orgId, eq(reviewComments.reviewId, r.id)))
    .orderBy(reviewComments.path, reviewComments.line);
  const [runHistory, findings, rejected] = await Promise.all([
    listReviewRuns(db, orgId, r.id, { limit: opts.runsLimit }),
    listFindings(db, orgId, { reviewId: r.id, visibility: ["published", "suppressed"], limit: opts.findingsLimit, offset: opts.findingsOffset }),
    listFindings(db, orgId, { reviewId: r.id, visibility: ["rejected"], limit: opts.rejectedLimit ?? 25, offset: opts.rejectedOffset }),
  ]);
  // Only a run of this review (one listed in its history) can be selected.
  const agentRunFor = opts.runId !== undefined && runHistory.some((r) => r.id === opts.runId) ? opts.runId : runHistory[0]?.id;
  const agents = agentRunFor !== undefined ? await listAgentRuns(db, orgId, agentRunFor) : [];
  return {
    id: r.id,
    repoFullName: row.repoFullName,
    prNumber: r.prNumber,
    prTitle: r.prTitle,
    prAuthor: r.prAuthor,
    status: r.status,
    riskLevel: r.riskLevel,
    confidence: r.confidence,
    commentCount: r.commentCount,
    creditsUsed: r.creditsUsed,
    runs: r.runs,
    mode: r.mode,
    openFindings: r.openFindings,
    resolvedFindings: r.resolvedFindings,
    costUsd: r.costUsd,
    lastRunId: r.lastRunId,
    updatedAt: r.updatedAt,
    headSha: r.headSha,
    pullRequest: row.pr && row.pr.baseRef !== null ? row.pr : null,
    summary: r.summary,
    error: r.error,
    usage: r.usage ?? null,
    createdAt: r.createdAt,
    comments,
    runHistory,
    agentRuns: agents,
    findings,
    rejected,
  };
}

export type ReviewStatus = (typeof reviewStatus.enumValues)[number];
export const REVIEW_STATUSES = reviewStatus.enumValues;

export interface ReviewFilter extends PageOptions {
  repoId?: number;
  status?: ReviewStatus;
  /** Review mode of the latest run: fast | standard | deep. */
  mode?: string;
}

export interface ReviewPageItem {
  id: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  headSha: string;
  status: string;
  mode: string;
  runs: number;
  /** Inline comments posted, and credits used, over all runs (R1.8). */
  commentCount: number;
  creditsUsed: number;
  costUsd: number;
  /** Latest run: when it started and finished, and the models it used. */
  lastRun: { id: number; status: string; trigger: string; startedAt: Date | null; finishedAt: Date | null; models: Record<string, string> | null } | null;
  /** Published findings, and the highest severity among them. */
  findings: number;
  highestSeverity: Severity | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The org's reviews, newest activity first, filtered by repository, status, and mode, paginated (R6.13). */
export async function listReviewPage(db: Db, orgId: string, filter: ReviewFilter = {}): Promise<Page<ReviewPageItem>> {
  const win = pageWindow(filter, 25);
  const where = scoped(
    reviews,
    orgId,
    filter.repoId !== undefined ? eq(reviews.repoId, filter.repoId) : undefined,
    filter.status ? eq(reviews.status, filter.status) : undefined,
    filter.mode ? eq(reviews.mode, filter.mode) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        review: reviews,
        repoFullName: repos.fullName,
        run: {
          id: reviewRuns.id,
          status: reviewRuns.status,
          trigger: reviewRuns.trigger,
          startedAt: reviewRuns.startedAt,
          finishedAt: reviewRuns.finishedAt,
          models: reviewRuns.models,
        },
      })
      .from(reviews)
      .innerJoin(repos, and(eq(reviews.repoId, repos.id), eq(repos.orgId, orgId)))
      .leftJoin(reviewRuns, and(eq(reviewRuns.id, reviews.lastRunId), eq(reviewRuns.orgId, orgId)))
      .where(where)
      .orderBy(desc(reviews.updatedAt), desc(reviews.id))
      .limit(win.pageSize)
      .offset(win.offset),
    db.select({ n: count() }).from(reviews).where(where),
  ]);
  const stats = await findingStatsByReview(
    db,
    orgId,
    rows.map((r) => r.review.id),
  );
  const items = rows.map(({ review: r, repoFullName, run }) => ({
    id: r.id,
    repoId: r.repoId,
    repoFullName,
    prNumber: r.prNumber,
    prTitle: r.prTitle,
    prAuthor: r.prAuthor,
    headSha: r.headSha,
    status: r.status,
    mode: r.mode,
    runs: r.runs,
    commentCount: r.commentCount,
    creditsUsed: r.creditsUsed,
    costUsd: r.costUsd,
    lastRun: run && run.id !== null ? run : null,
    findings: stats.get(r.id)?.count ?? 0,
    highestSeverity: stats.get(r.id)?.highest ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return toPage(items, Number(total?.n ?? 0), win);
}

async function findingStatsByReview(db: Db, orgId: string, reviewIds: number[]) {
  const out = new Map<number, { count: number; highest: Severity | null }>();
  if (!reviewIds.length) return out;
  const rows = await db
    .select({ reviewId: findings.reviewId, n: count(), best: sql<number>`min(${severityRank})`.mapWith(Number) })
    .from(findings)
    .where(scoped(findings, orgId, inArray(findings.reviewId, reviewIds), eq(findings.visibility, "published")))
    .groupBy(findings.reviewId);
  for (const r of rows) out.set(r.reviewId, { count: Number(r.n), highest: SEVERITIES[r.best] ?? null });
  return out;
}
