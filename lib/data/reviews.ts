import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { agentRuns, repos, reviewComments, reviewRuns, reviews, type StageTiming } from "@/lib/db/schema";
import { listFindings, type FindingRow } from "./findings";
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
  return db
    .select({
      id: reviewRuns.id,
      status: reviewRuns.status,
      statusReason: reviewRuns.statusReason,
      trigger: reviewRuns.trigger,
      mode: reviewRuns.mode,
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
    .select({ review: reviews, repoFullName: repos.fullName })
    .from(reviews)
    .innerJoin(repos, and(eq(reviews.repoId, repos.id), eq(repos.orgId, orgId)))
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
  const agentRunFor = opts.runId ?? runHistory[0]?.id;
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
