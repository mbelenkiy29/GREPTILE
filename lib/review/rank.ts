import { ruleApplies, type ReviewRule } from "@/lib/rules";
import type { FileDiff } from "./diff";
import { similarity } from "./text";
import { matchPattern, type LearnedPattern } from "@/lib/learning";
import type { Finding, RawFinding, Severity } from "./findings";

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 8, high: 4, medium: 2, low: 1 };

function score(f: { severity: Severity; confidence: number; agents: string[] }) {
  return SEVERITY_WEIGHT[f.severity] * f.confidence * (1 + 0.5 * (f.agents.length - 1));
}

/** Moves a finding onto a line GitHub accepts comments on, or returns null if none is near. */
function anchor(f: RawFinding, d: FileDiff): RawFinding | null {
  let line = f.line;
  if (!d.commentable.has(line)) {
    const near = [...d.commentable].filter((n) => Math.abs(n - line) <= 3).sort((a, b) => Math.abs(a - line) - Math.abs(b - line));
    if (near[0] === undefined) return null;
    line = near[0];
  }
  let endLine = f.endLine;
  if (endLine !== null) {
    const rangeOk = endLine > line && endLine - line <= 50 && Array.from({ length: endLine - line + 1 }, (_, i) => line + i).every((n) => d.commentable.has(n));
    if (!rangeOk) endLine = null;
  }
  // A multi-line replacement anchored to a single line would clobber the wrong code; drop it.
  const suggestion = f.suggestion !== null && endLine === null && f.endLine !== null && f.endLine !== f.line ? null : f.suggestion;
  return { ...f, line, endLine, suggestion };
}

/**
 * Final pass over all reviewer agents' output (R1.4): anchors findings to
 * commentable diff lines, merges duplicates reported by several agents (same
 * file, nearby lines, similar title or body), drops low-confidence
 * noise, and ranks by severity × confidence, boosted by agreement.
 */
export function rankFindings(
  raw: { agent: string; category: string; finding: RawFinding }[],
  diffs: FileDiff[],
  opts: {
    maxComments?: number;
    minConfidence?: number;
    minSeverity?: Severity;
    rules?: ReviewRule[];
    /** Learned from feedback (R2.4): suppressed patterns are dropped, boosted ones ranked higher. */
    learned?: LearnedPattern[];
  } = {},
): Finding[] {
  const rulesById = new Map((opts.rules ?? []).map((r) => [r.id, r]));
  /** A citation is kept only if the rule exists and covers the finding's file. */
  const citedRule = (f: RawFinding) => {
    const id = f.ruleId?.replace(/^\[|\]$/g, "");
    const rule = id ? rulesById.get(id) : undefined;
    return rule && ruleApplies(rule, f.path) ? { id: rule.id, text: rule.text } : undefined;
  };
  const byPath = new Map(diffs.map((d) => [d.path, d]));
  const merged: Finding[] = [];

  for (const { agent, category, finding } of raw) {
    const d = byPath.get(finding.path);
    if (!d || finding.confidence < (opts.minConfidence ?? 2)) continue;
    if (opts.minSeverity && SEVERITY_WEIGHT[finding.severity] < SEVERITY_WEIGHT[opts.minSeverity]) continue;
    if (matchPattern(opts.learned ?? [], { category, title: finding.title })?.signal === "suppress") continue;
    const f = anchor(finding, d);
    if (!f) continue;
    const dup = merged.find(
      (m) =>
        m.path === f.path &&
        Math.abs(m.line - f.line) <= 3 &&
        (similarity(m.title, f.title) >= 0.4 ||
          similarity(m.body, f.body) >= 0.5 ||
          (m.line === f.line && m.category === category && !m.agents.includes(agent))),
    );
    const rule = citedRule(f);
    if (!dup) {
      merged.push({ ...f, ruleId: rule?.id ?? null, category, agents: [agent], score: 0, ...(rule ? { rule } : {}) });
      continue;
    }
    if (!dup.agents.includes(agent)) dup.agents.push(agent);
    const incomingWins =
      SEVERITY_WEIGHT[f.severity] * f.confidence > SEVERITY_WEIGHT[dup.severity] * dup.confidence;
    if (incomingWins) Object.assign(dup, { ...f, ruleId: dup.ruleId, category, agents: dup.agents });
    dup.suggestion ??= f.suggestion;
    if (!dup.rule && rule) Object.assign(dup, { rule, ruleId: rule.id });
  }

  // Rule violations are what the team explicitly asked for, so they rank above equal-severity findings.
  for (const m of merged) {
    const boosted = matchPattern(opts.learned ?? [], m)?.signal === "boost";
    m.score = score(m) * (m.rule ? 1.25 : 1) * (boosted ? 1.5 : 1);
  }
  return merged
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, opts.maxComments ?? 20);
}
