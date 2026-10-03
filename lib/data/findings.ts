/**
 * Finding persistence and lifecycle (S10, R6.9). Findings are stored once per (PR review, fingerprint) and tracked
 * across commits: a re-detected finding updates its row (location, confidence, last seen run and commit) instead of
 * adding a new one, a finding fixed by a later commit is marked resolved, and candidates the engine rejected are
 * kept (visibility `rejected`) with the reason, for transparency.
 */
import { createHash } from "node:crypto";
import { and, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { findings, reviewComments } from "@/lib/db/schema";
import type { EngineFinding, HistoricalFinding, PriorFinding, RejectedCandidate } from "@/lib/engine/types";
import { scoped } from "./tenant";

export type FindingRow = typeof findings.$inferSelect;
export type FindingStatus = FindingRow["status"];
export type FindingVisibility = FindingRow["visibility"];

/** Rejected candidates stored per run, at most. */
export const MAX_REJECTED_PER_RUN = 100;

export interface RunScope {
  orgId: string;
  repoId: number;
  reviewId: number;
  prNumber: number;
  runId: number;
  headSha: string;
}

function normalize(s: string) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stable id for a rejected candidate: never collides with a real finding's fingerprint. */
export function rejectedFingerprint(r: Pick<RejectedCandidate, "path" | "category" | "title" | "startLine">): string {
  return "rej:" + createHash("sha256").update(`${r.path}\0${r.category}\0${r.startLine}\0${normalize(r.title)}`).digest("hex").slice(0, 16);
}

/** Open, published findings of a PR review, as the engine's prior findings (incremental tracking). */
export async function loadPriorFindings(db: Db, orgId: string, reviewId: number): Promise<(PriorFinding & { externalCommentId: number | null })[]> {
  const rows = await db
    .select()
    .from(findings)
    .where(scoped(findings, orgId, eq(findings.reviewId, reviewId), eq(findings.status, "open"), eq(findings.visibility, "published")))
    .orderBy(findings.id);
  return rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint,
    title: r.title,
    description: r.description,
    category: r.category as PriorFinding["category"],
    severity: r.severity as PriorFinding["severity"],
    path: r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    anchorCode: r.anchorCode,
    symbol: r.symbol,
    externalCommentId: r.externalCommentId,
  }));
}

const FEEDBACK_BY_STATUS: Partial<Record<FindingStatus, HistoricalFinding["feedback"]>> = {
  resolved: "useful",
  dismissed: "not_useful",
  false_positive: "false_positive",
  wont_fix: "wont_fix",
};

/** Recent published findings in the same files from other PRs of the repo, with how they ended (R6.5). */
export async function loadHistoricalFindings(
  db: Db,
  orgId: string,
  input: { repoId: number; excludeReviewId: number; paths: string[]; limit?: number },
): Promise<HistoricalFinding[]> {
  if (!input.paths.length) return [];
  const rows = await db
    .select({ title: findings.title, category: findings.category, path: findings.path, status: findings.status })
    .from(findings)
    .where(
      scoped(
        findings,
        orgId,
        eq(findings.repoId, input.repoId),
        ne(findings.reviewId, input.excludeReviewId),
        eq(findings.visibility, "published"),
        inArray(findings.path, input.paths.slice(0, 500)),
      ),
    )
    .orderBy(desc(findings.createdAt))
    .limit(input.limit ?? 30);
  return rows.map((r) => ({
    title: r.title,
    category: r.category as HistoricalFinding["category"],
    path: r.path,
    status: r.status,
    feedback: FEEDBACK_BY_STATUS[r.status] ?? null,
  }));
}

function findingValues(scope: RunScope, f: EngineFinding, visibility: FindingVisibility, verification: unknown) {
  return {
    title: f.title,
    description: f.description,
    impact: f.impact,
    severity: f.severity,
    confidence: Math.min(1, Math.max(0, f.confidence)),
    category: f.category,
    agent: f.agents[0] ?? f.category,
    agents: f.agents,
    path: f.path,
    startLine: f.startLine,
    endLine: Math.max(f.endLine, f.startLine),
    symbol: f.symbol,
    anchorCode: f.anchorCode,
    commitSha: scope.headSha,
    evidence: f.evidence,
    suggestedFix: f.suggestedFix,
    suggestion: f.suggestion,
    ruleId: f.rule?.id ?? null,
    ruleText: f.rule?.text ?? null,
    verification,
    visibility,
    lastRunId: scope.runId,
  };
}

/** On re-detection: reopen a finding that had been marked fixed; keep a person's decision (dismissed etc.). */
const reopenStatus = sql`case when ${findings.status} = 'resolved' then 'open'::finding_status else ${findings.status} end`;
const keepPublished = (incoming: SQL) => sql`case when ${findings.visibility} = 'published' then 'published'::finding_visibility else ${incoming} end`;

export interface AcceptedFinding {
  finding: EngineFinding;
  visibility: "published" | "suppressed";
  /** Inline comment that published it (new in this run), if any. */
  externalCommentId: number | null;
  /** Why an accepted finding was held back (e.g. over the comment limit). */
  heldBackReason?: string;
}

/**
 * Upserts this run's accepted findings. A finding the engine matched to a prior finding updates that row (even when
 * its fingerprint changed after a line move); others upsert by (review, fingerprint). Returns row ids by fingerprint.
 */
export async function upsertFindings(db: Db, scope: RunScope, accepted: AcceptedFinding[]): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const a of accepted) {
    const verification = a.heldBackReason ? { ...a.finding.verification, heldBack: a.heldBackReason } : a.finding.verification;
    const values = findingValues(scope, a.finding, a.visibility, verification);
    const update = {
      ...values,
      visibility: keepPublished(sql`${a.visibility}::finding_visibility`),
      status: reopenStatus,
      resolvedAt: sql`case when ${findings.status} = 'resolved' then null else ${findings.resolvedAt} end`,
      resolvedSha: sql`case when ${findings.status} = 'resolved' then null else ${findings.resolvedSha} end`,
      resolution: sql`case when ${findings.status} = 'resolved' then null else ${findings.resolution} end`,
      externalCommentId: a.externalCommentId ?? sql`${findings.externalCommentId}`,
    };
    if (a.finding.priorFindingId !== null) {
      const [row] = await db
        .update(findings)
        .set(update)
        .where(scoped(findings, scope.orgId, eq(findings.id, a.finding.priorFindingId), eq(findings.reviewId, scope.reviewId)))
        .returning({ id: findings.id });
      if (row) {
        ids.set(a.finding.fingerprint, row.id);
        continue;
      }
    }
    const [row] = await db
      .insert(findings)
      .values({
        ...values,
        orgId: scope.orgId,
        repoId: scope.repoId,
        reviewId: scope.reviewId,
        prNumber: scope.prNumber,
        firstRunId: scope.runId,
        firstSeenSha: scope.headSha,
        fingerprint: a.finding.fingerprint,
        externalCommentId: a.externalCommentId,
      })
      .onConflictDoUpdate({ target: [findings.reviewId, findings.fingerprint], set: update })
      .returning({ id: findings.id });
    ids.set(a.finding.fingerprint, row!.id);
  }
  return ids;
}

/** Stores rejected candidates (at most {@link MAX_REJECTED_PER_RUN}) with the stage and reason they were dropped. */
export async function storeRejected(db: Db, scope: RunScope, rejected: RejectedCandidate[]): Promise<number> {
  const seen = new Set<string>();
  const rows = [];
  for (const r of rejected) {
    const fingerprint = rejectedFingerprint(r);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    rows.push({ r, fingerprint });
    if (rows.length >= MAX_REJECTED_PER_RUN) break;
  }
  for (const { r, fingerprint } of rows) {
    const verification = { verdict: "reject", stage: r.stage, reasons: [r.reason] };
    await db
      .insert(findings)
      .values({
        orgId: scope.orgId,
        repoId: scope.repoId,
        reviewId: scope.reviewId,
        prNumber: scope.prNumber,
        firstRunId: scope.runId,
        lastRunId: scope.runId,
        title: r.title,
        description: r.reason,
        severity: r.severity,
        confidence: Math.min(1, Math.max(0, r.confidence)),
        category: r.category,
        agent: r.agent,
        agents: [r.agent],
        path: r.path,
        startLine: r.startLine,
        endLine: r.startLine,
        commitSha: scope.headSha,
        firstSeenSha: scope.headSha,
        verification,
        visibility: "rejected",
        fingerprint,
      })
      .onConflictDoUpdate({
        target: [findings.reviewId, findings.fingerprint],
        set: { lastRunId: scope.runId, commitSha: scope.headSha, confidence: Math.min(1, Math.max(0, r.confidence)), description: r.reason, verification },
      });
  }
  return rows.length;
}

/** Marks prior findings fixed by this run's head commit as resolved. Returns the rows that changed. */
export async function resolveFindings(
  db: Db,
  scope: RunScope,
  resolved: { id: number; reason: string }[],
  now: Date = new Date(),
): Promise<{ id: number; externalCommentId: number | null }[]> {
  if (!resolved.length) return [];
  return db
    .update(findings)
    .set({ status: "resolved", resolution: "fixed", resolvedAt: now, resolvedSha: scope.headSha, lastRunId: scope.runId })
    .where(
      scoped(
        findings,
        scope.orgId,
        eq(findings.reviewId, scope.reviewId),
        eq(findings.status, "open"),
        inArray(
          findings.id,
          resolved.map((r) => r.id),
        ),
      ),
    )
    .returning({ id: findings.id, externalCommentId: findings.externalCommentId });
}

/** Records the inline comments posted in this run (learning reads feedback through them, R2.4). */
export async function recordPostedComments(
  db: Db,
  scope: RunScope,
  posted: { finding: EngineFinding; findingId: number | null; externalId: number | null; body: string }[],
): Promise<void> {
  if (!posted.length) return;
  await db
    .insert(reviewComments)
    .values(
      posted.map(({ finding: f, findingId, externalId }) => ({
        orgId: scope.orgId,
        reviewId: scope.reviewId,
        path: f.path,
        line: f.startLine,
        category: f.category,
        severity: f.severity,
        title: f.title,
        body: f.description,
        fingerprint: f.fingerprint,
        ruleId: f.rule?.id ?? null,
        externalId,
        headSha: scope.headSha,
        findingId,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Moves open findings to the path they now live at (a file the pull request renamed). The engine tracks prior
 * findings under the new path; this keeps the stored rows in step. Returns how many rows changed.
 */
export async function relocateFindings(db: Db, scope: RunScope, moved: { id: number; path: string }[]): Promise<number> {
  let changed = 0;
  for (const m of moved) {
    const rows = await db
      .update(findings)
      .set({ path: m.path })
      .where(scoped(findings, scope.orgId, eq(findings.reviewId, scope.reviewId), eq(findings.id, m.id), ne(findings.path, m.path)))
      .returning({ id: findings.id });
    changed += rows.length;
  }
  return changed;
}

/** Open / resolved counts of a review's published findings. */
export async function findingCounts(db: Db, orgId: string, reviewId: number): Promise<{ open: number; resolved: number }> {
  const rows = await db
    .select({ status: findings.status, n: count() })
    .from(findings)
    .where(scoped(findings, orgId, eq(findings.reviewId, reviewId), eq(findings.visibility, "published")))
    .groupBy(findings.status);
  const of = (s: FindingStatus) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { open: of("open"), resolved: of("resolved") };
}

export interface FindingFilter {
  reviewId?: number;
  repoId?: number;
  visibility?: FindingVisibility[];
  status?: FindingStatus[];
  limit?: number;
  offset?: number;
}

/** The org's findings, newest first, filtered and paginated (dashboard). */
export async function listFindings(db: Db, orgId: string, filter: FindingFilter = {}): Promise<{ items: FindingRow[]; total: number }> {
  const where = scoped(
    findings,
    orgId,
    filter.reviewId !== undefined ? eq(findings.reviewId, filter.reviewId) : undefined,
    filter.repoId !== undefined ? eq(findings.repoId, filter.repoId) : undefined,
    filter.visibility?.length ? inArray(findings.visibility, filter.visibility) : undefined,
    filter.status?.length ? inArray(findings.status, filter.status) : undefined,
  );
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(findings)
      .where(where)
      .orderBy(desc(findings.updatedAt), desc(findings.id))
      .limit(Math.min(filter.limit ?? 50, 200))
      .offset(filter.offset ?? 0),
    db.select({ n: count() }).from(findings).where(where),
  ]);
  return { items, total: Number(total?.n ?? 0) };
}

/** A person's decision on a finding (dismissed, won't fix, false positive, or resolved by hand). */
export async function setFindingStatus(
  db: Db,
  orgId: string,
  findingId: number,
  status: Exclude<FindingStatus, "open"> | "open",
  now: Date = new Date(),
): Promise<FindingRow | undefined> {
  const [row] = await db
    .update(findings)
    .set(
      status === "open"
        ? { status, resolvedAt: null, resolution: null, resolvedSha: null }
        : { status, resolvedAt: now, resolution: status === "resolved" ? "user" : null },
    )
    .where(and(scoped(findings, orgId, eq(findings.id, findingId)), ne(findings.visibility, "rejected")))
    .returning();
  return row;
}
