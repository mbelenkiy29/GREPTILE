import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { repos, reviewComments, reviews } from "@/lib/db/schema";
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
  updatedAt: Date;
}

/** The org's reviews, most recently updated first (R1.8). */
export async function listReviews(db: Db, orgId: string, opts: { repoId?: number; limit?: number } = {}): Promise<ReviewListItem[]> {
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
      updatedAt: reviews.updatedAt,
    })
    .from(reviews)
    .innerJoin(repos, and(eq(reviews.repoId, repos.id), eq(repos.orgId, orgId)))
    .where(scoped(reviews, orgId, opts.repoId ? eq(reviews.repoId, opts.repoId) : undefined))
    .orderBy(desc(reviews.updatedAt), desc(reviews.id))
    .limit(opts.limit ?? 100);
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
}

export async function getReviewDetail(db: Db, orgId: string, reviewId: number): Promise<ReviewDetail | undefined> {
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
    updatedAt: r.updatedAt,
    headSha: r.headSha,
    summary: r.summary,
    error: r.error,
    usage: r.usage ?? null,
    createdAt: r.createdAt,
    comments,
  };
}
