/**
 * Matching review findings to a case's documented issues (R6.24).
 *
 * A finding matches an expected issue when it is on the same file, its line range overlaps the issue's range widened
 * by {@link LINE_TOLERANCE} lines on each side, and it has the issue's category or mentions one of its keywords (in the
 * title, description, impact, or suggested fix; case-insensitive). Findings are classified strongest first
 * (severity, then confidence):
 *
 * - true positive: the first finding to match an expected issue;
 * - duplicate: a finding that only matches issues an earlier finding already matched;
 * - false positive: a finding that matches no expected issue (noting the documented non-issue it hit, if any);
 * - missed: an expected issue no finding matched.
 *
 * Precision = TP / (TP + FP) and recall = TP / expected; duplicates are reported separately (they are noise, not
 * wrong claims). Either is null when its denominator is zero.
 */
import type { ExpectedIssue, NonIssue } from "./cases";

export const LINE_TOLERANCE = 5;

export interface EvalFinding {
  path: string;
  startLine: number;
  endLine: number;
  category: string;
  severity: string;
  confidence: number;
  title: string;
  description: string;
  impact?: string;
  suggestedFix?: string;
}

export interface MatchResult {
  truePositives: { finding: EvalFinding; issue: string }[];
  duplicates: { finding: EvalFinding; issue: string }[];
  falsePositives: { finding: EvalFinding; nonIssue: string | null }[];
  missed: ExpectedIssue[];
  counts: { expected: number; truePositives: number; falsePositives: number; duplicates: number; missed: number };
  precision: number | null;
  recall: number | null;
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const normalize = (p: string) => p.replace(/^\.?\//, "");

function overlaps(f: Pick<EvalFinding, "startLine" | "endLine">, range: readonly [number, number], tolerance = LINE_TOLERANCE): boolean {
  const start = Math.min(f.startLine, f.endLine);
  const end = Math.max(f.startLine, f.endLine);
  return start <= range[1] + tolerance && end >= range[0] - tolerance;
}

function text(f: EvalFinding): string {
  return [f.title, f.description, f.impact ?? "", f.suggestedFix ?? ""].join("\n").toLowerCase();
}

function mentions(f: EvalFinding, keywords: readonly string[]): boolean {
  const t = text(f);
  return keywords.some((k) => t.includes(k.toLowerCase()));
}

/** Whether `f` is a report of `issue` (same file, overlapping lines ±5, category or keyword). */
export function findingMatches(f: EvalFinding, issue: ExpectedIssue): boolean {
  return normalize(f.path) === normalize(issue.file) && overlaps(f, issue.lines) && (f.category === issue.category || mentions(f, issue.keywords));
}

/** Whether `f` hits a documented non-issue (same file, overlapping lines when given, and a keyword when given). */
export function findingHitsNonIssue(f: EvalFinding, n: NonIssue): boolean {
  if (normalize(f.path) !== normalize(n.file)) return false;
  if (n.lines && !overlaps(f, n.lines)) return false;
  return n.keywords.length === 0 || mentions(f, n.keywords);
}

const ratio = (num: number, den: number) => (den === 0 ? null : Math.round((num / den) * 1000) / 1000);

export function matchFindings(findings: readonly EvalFinding[], expected: readonly ExpectedIssue[], nonIssues: readonly NonIssue[] = []): MatchResult {
  const ordered = [...findings].sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || b.confidence - a.confidence);
  const matched = new Set<string>();
  const truePositives: MatchResult["truePositives"] = [];
  const duplicates: MatchResult["duplicates"] = [];
  const falsePositives: MatchResult["falsePositives"] = [];
  for (const f of ordered) {
    const hits = expected.filter((e) => findingMatches(f, e));
    const fresh = hits.find((e) => !matched.has(e.id));
    if (fresh) {
      matched.add(fresh.id);
      truePositives.push({ finding: f, issue: fresh.id });
    } else if (hits.length) {
      duplicates.push({ finding: f, issue: hits[0]!.id });
    } else {
      falsePositives.push({ finding: f, nonIssue: nonIssues.find((n) => findingHitsNonIssue(f, n))?.id ?? null });
    }
  }
  const missed = expected.filter((e) => !matched.has(e.id));
  return {
    truePositives,
    duplicates,
    falsePositives,
    missed,
    counts: { expected: expected.length, truePositives: truePositives.length, falsePositives: falsePositives.length, duplicates: duplicates.length, missed: missed.length },
    precision: ratio(truePositives.length, truePositives.length + falsePositives.length),
    recall: ratio(truePositives.length, expected.length),
  };
}
