import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { reviewComments } from "@/lib/db/schema";
import type { GitClient, NewInlineComment } from "@/lib/git/types";
import type { ReviewResult } from "./engine";
import type { Finding } from "./findings";
import {
  SUMMARY_MARKER,
  findingFingerprint,
  fingerprintFromBody,
  renderInlineComment,
  renderSummaryComment,
} from "./format";

export interface PublishOutcome {
  summaryCommentId: number;
  posted: number;
  skipped: number;
}

/**
 * Writes a review to the PR (R1.5): one summary comment, updated in place on
 * every re-review, plus inline comments for findings not already on the PR
 * (R1.6). Previously posted findings are recognized by fingerprint, both from
 * our own records and from markers in comments already on GitHub.
 */
export async function publishReview(
  deps: { db: Db; client: GitClient },
  input: {
    orgId: string;
    reviewId: number;
    repoFullName: string;
    summaryCommentId: number | null;
    runs: number;
    result: ReviewResult;
  },
): Promise<PublishOutcome> {
  const { db, client } = deps;
  const { result, repoFullName } = input;
  const prNumber = result.pr.number;

  const summaryBody = renderSummaryComment({
    notices: result.notices,
    summary: result.summary,
    findings: result.findings,
    context: result.context,
    headSha: result.pr.headSha,
    filesReviewed: result.diffs.length,
    runs: input.runs,
  });

  let summaryCommentId = input.summaryCommentId;
  if (summaryCommentId === null) {
    const existing = (await client.listIssueComments(repoFullName, prNumber)).find((c) => c.body.startsWith(SUMMARY_MARKER));
    summaryCommentId = existing?.id ?? null;
  }
  if (summaryCommentId !== null) {
    try {
      await client.updateIssueComment(repoFullName, summaryCommentId, summaryBody);
    } catch {
      summaryCommentId = null; // deleted by a user: post a fresh one
    }
  }
  if (summaryCommentId === null) {
    summaryCommentId = (await client.createIssueComment(repoFullName, prNumber, summaryBody)).id;
  }

  const known = new Set(
    (await db.select({ fp: reviewComments.fingerprint }).from(reviewComments).where(eq(reviewComments.reviewId, input.reviewId))).map(
      (r) => r.fp,
    ),
  );
  for (const c of await client.listReviewComments(repoFullName, prNumber)) {
    const fp = fingerprintFromBody(c.body);
    if (fp) known.add(fp);
  }

  const diffByPath = new Map(result.diffs.map((d) => [d.path, d]));
  const fresh: { finding: Finding; fp: string; comment: NewInlineComment }[] = [];
  let skipped = 0;
  for (const f of result.findings) {
    const fp = findingFingerprint(f, diffByPath.get(f.path));
    if (known.has(fp)) {
      skipped++;
      continue;
    }
    known.add(fp);
    const comment: NewInlineComment =
      f.endLine !== null
        ? { path: f.path, startLine: f.line, line: f.endLine, body: renderInlineComment(f, fp) }
        : { path: f.path, line: f.line, body: renderInlineComment(f, fp) };
    fresh.push({ finding: f, fp, comment });
  }

  if (fresh.length) {
    const posted = await client.createReview(repoFullName, prNumber, {
      commitId: result.pr.headSha,
      body: "",
      comments: fresh.map((x) => x.comment),
    });
    const idByFp = new Map(
      posted.comments.flatMap((c) => {
        const fp = fingerprintFromBody(c.body);
        return fp ? [[fp, c.id] as const] : [];
      }),
    );
    await db
      .insert(reviewComments)
      .values(
        fresh.map(({ finding: f, fp }) => ({
          orgId: input.orgId,
          reviewId: input.reviewId,
          path: f.path,
          line: f.line,
          category: f.category,
          severity: f.severity,
          title: f.title,
          body: f.body,
          fingerprint: fp,
          ruleId: f.rule?.id ?? null,
          externalId: idByFp.get(fp) ?? null,
          headSha: result.pr.headSha,
        })),
      )
      .onConflictDoNothing();
  }

  return { summaryCommentId, posted: fresh.length, skipped };
}
