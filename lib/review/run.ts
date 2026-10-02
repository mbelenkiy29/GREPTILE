import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { installations, repos, reviewComments, reviews } from "@/lib/db/schema";
import type { GitHost } from "@/lib/git/types";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import { activeRulesForRepo } from "@/lib/data/rules";
import { reviewPullRequest, type ReviewOptions } from "./engine";
import { publishReview } from "./publish";

/** Credits charged per completed review run (review tiers arrive in R4.1). */
export const CREDITS_PER_REVIEW = 1;

export interface ReviewJobDeps {
  db: Db;
  host: GitHost;
  llm: LlmProvider;
  embedder?: EmbeddingProvider;
}

/**
 * The `review-pr` job: one `reviews` row per PR, updated in place on every
 * push (R1.6); runs the engine (R1.4) and publishes to the PR (R1.5).
 */
export async function runReviewJob(
  deps: ReviewJobDeps,
  job: { orgId: string; repoId: number; prNumber: number; headSha: string },
  opts: ReviewOptions = {},
) {
  const { db } = deps;
  const [row] = await db
    .select({ repo: repos, installation: installations })
    .from(repos)
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(and(eq(repos.orgId, job.orgId), eq(repos.id, job.repoId)));
  if (!row) throw new Error(`repo ${job.repoId} not found for org ${job.orgId}`);
  if (!row.repo.enabled || row.installation.suspended) return { status: "skipped" as const };

  const client = deps.host.client(row.installation.externalId);
  const pr = await client.getPullRequest(row.repo.fullName, job.prNumber);
  // Only the newest commit is reviewed; an older job that runs late must not overwrite newer output.
  if (pr.state !== "open" || pr.headSha !== job.headSha) return { status: "superseded" as const };

  const [review] = await db
    .insert(reviews)
    .values({ orgId: job.orgId, repoId: job.repoId, prNumber: job.prNumber, headSha: job.headSha, status: "running", runs: 1 })
    .onConflictDoUpdate({
      target: [reviews.repoId, reviews.prNumber],
      set: { headSha: job.headSha, status: "running", error: null, runs: sql`${reviews.runs} + 1` },
    })
    .returning();

  try {
    const rules = await activeRulesForRepo(db, job.orgId, job.repoId);
    const result = await reviewPullRequest(
      deps,
      { orgId: job.orgId, repoId: job.repoId, repoFullName: row.repo.fullName, prNumber: job.prNumber, client, pr },
      { rules, ...opts },
    );
    const published = await publishReview(
      { db, client },
      {
        orgId: job.orgId,
        reviewId: review!.id,
        repoFullName: row.repo.fullName,
        summaryCommentId: review!.summaryCommentId,
        runs: review!.runs,
        result,
      },
    );
    const [{ total }] = (await db
      .select({ total: count() })
      .from(reviewComments)
      .where(eq(reviewComments.reviewId, review!.id))) as [{ total: number }];
    const prior = review!.usage ?? { inputTokens: 0, outputTokens: 0 };
    await db
      .update(reviews)
      .set({
        status: "completed",
        prTitle: result.pr.title,
        prAuthor: result.pr.author,
        headSha: result.pr.headSha,
        riskLevel: result.summary.riskLevel,
        confidence: result.summary.confidence,
        summary: result.summary.whatChanged.join("\n"),
        summaryCommentId: published.summaryCommentId,
        commentCount: Number(total),
        creditsUsed: sql`${reviews.creditsUsed} + ${CREDITS_PER_REVIEW}`,
        usage: {
          inputTokens: prior.inputTokens + result.usage.inputTokens,
          outputTokens: prior.outputTokens + result.usage.outputTokens,
        },
      })
      .where(eq(reviews.id, review!.id));
    return { status: "completed" as const, reviewId: review!.id, ...published, findings: result.findings.length };
  } catch (err) {
    await db
      .update(reviews)
      .set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 2000) : String(err) })
      .where(eq(reviews.id, review!.id));
    throw err;
  }
}
