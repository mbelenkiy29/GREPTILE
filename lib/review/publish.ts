/**
 * Publishing a review run to the pull request (S13, R1.5, R1.6) and persisting its findings (R6.9). Comment bodies
 * come from the engine's renderers (`renderFindingMarkdown`, `renderSummaryMarkdown`), so every surface shows the
 * same text.
 *
 * - The summary comment (`<!-- openreview:summary -->`) is created once and then edited in place on every re-review.
 * - New findings are posted as ONE GitHub review (event COMMENT) with inline comments; never more than
 *   `maxComments` new comments per run (the rest are stored as `suppressed`).
 * - Only findings the engine did not match to a prior finding (`priorFindingId === null`) are posted, and only when
 *   their fingerprint is not already on the PR (our records, or the `<!-- openreview:fp=… -->` marker in a comment
 *   on GitHub). A re-detected prior finding keeps its original comment, even after its lines moved.
 * - Prior findings the new commits fixed get their original inline comment edited to start with
 *   "✅ Resolved in <sha7>" (an edit sends no notification) and are marked resolved.
 * - Open prior findings in files the PR renamed are moved to the new path.
 * - The summary counts every finding still open on the PR: this run's, plus the engine's `openPriorFindings`
 *   (earlier ones an incremental re-review neither re-detected nor resolved).
 *
 * {@link publishReview} only reads the database and writes to GitHub; it never runs inside a transaction, so no row
 * locks are held across network calls. {@link persistPublication} then stores what was published in one short
 * transaction.
 */
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { findings, reviewComments } from "@/lib/db/schema";
import {
  recordPostedComments,
  relocateFindings,
  resolveFindings,
  storeRejected,
  upsertFindings,
  type AcceptedFinding,
  type RunScope,
} from "@/lib/data/findings";
import { scoped } from "@/lib/data/tenant";
import { fingerprintFromMarkdown, renderFindingMarkdown, renderSummaryMarkdown, SUMMARY_MARKER } from "@/lib/engine/markdown";
import type { EngineFinding, RejectedCandidate, ReviewOutput } from "@/lib/engine/types";
import type { GitClient, NewInlineComment, ReviewComment } from "@/lib/git/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";

export { SUMMARY_MARKER };
export const RESOLVED_PREFIX = "✅ Resolved in";

/** The fingerprint an OpenReview comment carries in its marker, or null for other comments. */
export const fingerprintFromBody = fingerprintFromMarkdown;

export function inlineCommentFor(f: EngineFinding, commentStyle: "concise" | "detailed" = "detailed"): NewInlineComment {
  const body = renderFindingMarkdown(f, { commentStyle });
  return f.endLine > f.startLine ? { path: f.path, startLine: f.startLine, line: f.endLine, body } : { path: f.path, line: f.startLine, body };
}

export interface PublishInput {
  scope: RunScope;
  repoFullName: string;
  /** Known summary comment id (from the `reviews` row), if any. */
  summaryCommentId: number | null;
  /** Ordinal of this review on the PR (completed runs including this one). */
  reviewNumber: number;
  output: ReviewOutput;
  notices: string[];
  maxComments: number;
  commentStyle?: "concise" | "detailed";
  /** Review comments already on the PR (fetched during ingestion); listed again when absent. */
  existingReviewComments?: ReviewComment[];
}

/** What a publish wrote to GitHub, for {@link persistPublication} to store. */
export interface PublishRecords {
  accepted: AcceptedFinding[];
  posted: { finding: EngineFinding; externalId: number | null }[];
  rejected: RejectedCandidate[];
  resolved: { id: number; reason: string }[];
  /** Open prior findings whose file the PR renamed: their new path. */
  moved: { id: number; path: string }[];
}

export interface PublishOutcome {
  summaryCommentId: number;
  /** New inline comments posted in this run. */
  posted: number;
  /** Findings already on the PR (re-detected) and therefore not posted again. */
  skipped: number;
  /** Accepted findings held back by the comment limit. */
  heldBack: number;
  resolved: number;
  githubReviewId: number | null;
  records: PublishRecords;
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/**
 * Publishes one run to GitHub (see the module comment). Reads the review's findings and posted comments, writes the
 * summary, the review, and the resolved-comment edits, and returns the records to persist. Call it outside any
 * transaction; the caller holds the PR's publishing slot.
 */
export async function publishReview(deps: { db: Db; client: GitClient; log?: Logger }, input: PublishInput): Promise<PublishOutcome> {
  const { db, client } = deps;
  const log = deps.log ?? rootLog;
  const { scope, repoFullName, output } = input;
  const prNumber = scope.prNumber;
  const commentStyle = input.commentStyle ?? "detailed";

  // Fingerprints already on the PR: our posted-comment records and the markers of comments on GitHub.
  const onGitHub = input.existingReviewComments ?? (await client.listReviewComments(repoFullName, prNumber));
  const known = new Set<string>();
  const commentByFp = new Map<string, number>();
  for (const c of onGitHub) {
    const fp = fingerprintFromBody(c.body);
    if (!fp) continue;
    known.add(fp);
    if (!commentByFp.has(fp)) commentByFp.set(fp, c.id);
  }
  const resolvedIds = output.resolvedPriorFindings.map((r) => r.id);
  const [recorded, resolvable] = await Promise.all([
    db.select({ fp: reviewComments.fingerprint }).from(reviewComments).where(scoped(reviewComments, scope.orgId, eq(reviewComments.reviewId, scope.reviewId))),
    resolvedIds.length
      ? db
          .select({ id: findings.id, externalCommentId: findings.externalCommentId })
          .from(findings)
          .where(scoped(findings, scope.orgId, eq(findings.reviewId, scope.reviewId), eq(findings.status, "open"), inArray(findings.id, resolvedIds)))
      : Promise.resolve([] as { id: number; externalCommentId: number | null }[]),
  ]);
  for (const r of recorded) known.add(r.fp);

  const accepted: AcceptedFinding[] = [];
  const fresh: EngineFinding[] = [];
  let skipped = 0;
  for (const f of output.findings) {
    // A finding the engine matched to a prior finding is that finding, already on the PR: never posted again.
    if (f.priorFindingId !== null || known.has(f.fingerprint)) {
      skipped++;
      // A comment found only by its marker on GitHub (e.g. a publish whose records were lost) is linked again.
      accepted.push({ finding: f, visibility: "published", externalCommentId: commentByFp.get(f.fingerprint) ?? null });
      continue;
    }
    if (fresh.length >= input.maxComments) {
      accepted.push({ finding: f, visibility: "suppressed", externalCommentId: null, heldBackReason: `over the limit of ${input.maxComments} new comments per review` });
      continue;
    }
    known.add(f.fingerprint);
    fresh.push(f);
  }

  const summaryBody = renderSummaryMarkdown(output, { notices: input.notices, headSha: scope.headSha, commentStyle, reviewNumber: input.reviewNumber });
  let summaryCommentId = input.summaryCommentId;
  if (summaryCommentId === null) {
    const existing = (await client.listIssueComments(repoFullName, prNumber)).find((c) => c.body.startsWith(SUMMARY_MARKER));
    summaryCommentId = existing?.id ?? null;
  }
  if (summaryCommentId !== null) {
    try {
      await client.updateIssueComment(repoFullName, summaryCommentId, summaryBody);
    } catch (err) {
      log.info("summary comment could not be updated; posting a new one", { commentId: summaryCommentId, error: errorMessage(err) });
      summaryCommentId = null;
    }
  }
  if (summaryCommentId === null) summaryCommentId = (await client.createIssueComment(repoFullName, prNumber, summaryBody)).id;

  let githubReviewId: number | null = null;
  const idByFp = new Map<string, number>();
  if (fresh.length) {
    const comments = fresh.map((f) => inlineCommentFor(f, commentStyle));
    const posted = await client.createReview(repoFullName, prNumber, { commitId: scope.headSha, body: "", comments });
    githubReviewId = posted.id;
    for (const c of posted.comments) {
      const fp = fingerprintFromBody(c.body);
      if (fp) idByFp.set(fp, c.id);
    }
  }
  for (const f of fresh) accepted.push({ finding: f, visibility: "published", externalCommentId: idByFp.get(f.fingerprint) ?? null });

  // Mark fixed findings on their original inline comments (an edit, so nobody is notified again).
  const toEdit = resolvable.filter((r): r is typeof r & { externalCommentId: number } => r.externalCommentId !== null);
  if (toEdit.length) {
    const bodies = new Map(onGitHub.map((c) => [c.id, c.body]));
    const sha7 = scope.headSha.slice(0, 7);
    await inBatches(toEdit, 4, async (r) => {
      const body = bodies.get(r.externalCommentId);
      if (body === undefined || body.startsWith(RESOLVED_PREFIX)) return;
      try {
        await client.updateReviewComment(repoFullName, r.externalCommentId, `${RESOLVED_PREFIX} ${sha7}\n\n${body}`);
      } catch (err) {
        log.warn("could not mark a resolved finding's comment", { commentId: r.externalCommentId, error: errorMessage(err) });
      }
    });
  }

  return {
    summaryCommentId,
    posted: fresh.length,
    skipped,
    heldBack: accepted.filter((a) => a.visibility === "suppressed").length,
    resolved: resolvable.length,
    githubReviewId,
    records: {
      accepted,
      posted: fresh.map((f) => ({ finding: f, externalId: idByFp.get(f.fingerprint) ?? null })),
      rejected: output.rejected,
      resolved: output.resolvedPriorFindings,
      moved: (output.openPriorFindings ?? []).map((p) => ({ id: p.id, path: p.path })),
    },
  };
}

/**
 * Stores what {@link publishReview} published (R6.9): resolutions, renamed paths, accepted findings (upserted by
 * fingerprint), the posted comments (learning maps feedback through them), and rejected candidates. Returns how many
 * rejected candidates were stored. Run it in the transaction that completes the run.
 */
export async function persistPublication(db: Db, scope: RunScope, records: PublishRecords): Promise<{ rejectedStored: number }> {
  await resolveFindings(db, scope, records.resolved);
  await relocateFindings(db, scope, records.moved);
  const ids = await upsertFindings(db, scope, records.accepted);
  await recordPostedComments(
    db,
    scope,
    records.posted.map((p) => ({ finding: p.finding, findingId: ids.get(p.finding.fingerprint) ?? null, externalId: p.externalId, body: p.finding.description })),
  );
  return { rejectedStored: await storeRejected(db, scope, records.rejected) };
}
