/**
 * Loads what a fix prompt (R3.1) needs for a stored finding: its pull request, the current code at the head commit
 * (read through the git host when a reader is given, else the stored evidence), related locations, and the tests that
 * cover the touched files (from the index). Tenant-scoped: a finding of another org is never found.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { files, findings, installations, pullRequests, repos, reviews } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import type { FindingRow } from "@/lib/data/findings";
import { importersOf, testsFor } from "@/lib/indexer/query";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import type { CodeExcerpt, FixContext, FixFinding } from "./prompt";

/** Reads a file at a commit through the git host; null when it does not exist there. */
/** Reads a file at a ref through the repository's git host; `provider` is the installation's (R3.6). */
export type FixFileReader = (input: { provider: string; installationExternalId: number; repoFullName: string; path: string; ref: string }) => Promise<string | null>;

/** Lines of context shown around the flagged range. */
const CONTEXT_LINES = 5;
const MAX_EXCERPT_LINES = 80;

export interface FindingFix {
  finding: FindingRow;
  repoFullName: string;
  fix: FixFinding;
  ctx: FixContext;
}

/** A stored finding as the prompt builder sees it. */
export function toFixFinding(f: FindingRow): FixFinding {
  return {
    title: f.title,
    description: f.description,
    impact: f.impact,
    severity: f.severity,
    confidence: f.confidence,
    category: f.category,
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    symbol: f.symbol,
    evidence: f.evidence,
    suggestedFix: f.suggestedFix,
    suggestion: f.suggestion,
    rule: f.ruleId || f.ruleText ? { id: f.ruleId ?? "rule", text: f.ruleText ?? "" } : null,
  };
}

/** The flagged lines plus a little context, cut from a whole file. */
export function excerptOf(content: string, startLine: number, endLine: number): { startLine: number; content: string } {
  const lines = content.split("\n");
  const from = Math.max(1, startLine - CONTEXT_LINES);
  const to = Math.min(lines.length, Math.max(endLine, startLine) + CONTEXT_LINES, from + MAX_EXCERPT_LINES - 1);
  return { startLine: from, content: lines.slice(from - 1, to).join("\n") };
}

/** Stored evidence that covers the flagged lines, as a fallback for the current code. */
function evidenceExcerpt(f: FindingRow): CodeExcerpt | null {
  const e = f.evidence.find((x) => x.path === f.path && x.startLine <= f.endLine && x.endLine >= f.startLine && x.snippet.trim());
  return e ? { path: e.path, startLine: e.startLine, content: e.snippet, ref: f.commitSha } : null;
}

/** Test files (and their test cases) covering `paths` in the repository index. */
export async function testsForPaths(db: Db, orgId: string, repoId: number, paths: string[]): Promise<{ path: string; cases: string[] }[]> {
  const unique = [...new Set(paths)].slice(0, 200);
  if (!unique.length) return [];
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(scoped(files, orgId, eq(files.repoId, repoId), inArray(files.path, unique)));
  if (!rows.length) return [];
  const hits = await testsFor(
    db,
    { orgId, repoId },
    rows.map((r) => r.id),
    { limit: 50, testsPerFile: 10 },
  );
  const out = new Map<string, string[]>();
  for (const h of hits) {
    if (unique.includes(h.testFile.path)) continue;
    const cases = out.get(h.testFile.path) ?? [];
    for (const t of h.tests) if (!cases.includes(t.name)) cases.push(t.name);
    out.set(h.testFile.path, cases);
  }
  return [...out.entries()].map(([path, cases]) => ({ path, cases }));
}

/** Files that import the finding's file (from the index): code a fix may have to keep working. */
export async function importersOfPath(db: Db, orgId: string, repoId: number, path: string): Promise<NonNullable<FixContext["related"]>> {
  const [file] = await db
    .select({ id: files.id })
    .from(files)
    .where(scoped(files, orgId, eq(files.repoId, repoId), eq(files.path, path)));
  if (!file) return [];
  const hits = await importersOf(db, { orgId, repoId }, [file.id], { limit: 8 });
  return hits.map((h) => ({ path: h.importer.path, startLine: h.line, endLine: h.line, note: `imports \`${path}\`` }));
}

/**
 * The finding (published or held back; rejected candidates are not fixable) with everything its fix prompt needs, or
 * undefined when the org has no such finding.
 */
export async function loadFindingFix(
  db: Db,
  orgId: string,
  findingId: number,
  opts: { readFile?: FixFileReader; log?: Logger } = {},
): Promise<FindingFix | undefined> {
  if (!Number.isSafeInteger(findingId)) return undefined;
  const [row] = await db
    .select({
      finding: findings,
      repoFullName: repos.fullName,
      installationExternalId: installations.externalId,
      provider: installations.provider,
      headSha: reviews.headSha,
      pr: { url: pullRequests.url, headRef: pullRequests.headRef, baseRef: pullRequests.baseRef, headSha: pullRequests.headSha },
    })
    .from(findings)
    .innerJoin(reviews, and(eq(reviews.id, findings.reviewId), eq(reviews.orgId, orgId)))
    .innerJoin(repos, and(eq(repos.id, findings.repoId), eq(repos.orgId, orgId)))
    .innerJoin(installations, and(eq(installations.id, repos.installationId), eq(installations.orgId, orgId)))
    .leftJoin(pullRequests, and(eq(pullRequests.id, reviews.pullRequestId), eq(pullRequests.orgId, orgId)))
    .where(scoped(findings, orgId, eq(findings.id, findingId), ne(findings.visibility, "rejected")));
  if (!row) return undefined;
  const f = row.finding;
  const headSha = row.pr?.headSha || row.headSha || f.commitSha;

  let currentCode: CodeExcerpt | null = null;
  if (opts.readFile) {
    try {
      const content = await opts.readFile({ provider: row.provider, installationExternalId: row.installationExternalId, repoFullName: row.repoFullName, path: f.path, ref: headSha });
      if (content !== null) currentCode = { path: f.path, ...excerptOf(content, f.startLine, f.endLine), ref: headSha };
    } catch (err) {
      (opts.log ?? rootLog).warn("could not read the finding's file for its fix prompt; using stored evidence", {
        orgId,
        findingId,
        repo: row.repoFullName,
        error: errorMessage(err),
      });
    }
  }
  currentCode ??= evidenceExcerpt(f);

  const [tests, related] = await Promise.all([
    testsForPaths(db, orgId, f.repoId, [f.path, ...f.evidence.map((e) => e.path)]),
    importersOfPath(db, orgId, f.repoId, f.path),
  ]);
  const prUrl = row.pr?.url && /^https?:\/\//i.test(row.pr.url) ? row.pr.url : null;
  return {
    finding: f,
    repoFullName: row.repoFullName,
    fix: toFixFinding(f),
    ctx: {
      repoFullName: row.repoFullName,
      prNumber: f.prNumber,
      prUrl,
      headSha: headSha || null,
      headRef: row.pr?.headRef ?? null,
      baseRef: row.pr?.baseRef ?? null,
      currentCode,
      related,
      tests,
    },
  };
}
