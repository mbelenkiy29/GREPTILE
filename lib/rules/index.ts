import picomatch from "picomatch";
import { SEVERITY_ORDER, type RuleCategory, type RuleSeverity } from "./catalog";

export * from "./catalog";

/** A rule as the review engine sees it, whatever its source (dashboard, openreview.json, mined). */
export interface ReviewRule {
  id: string;
  text: string;
  /** Glob paths the rule is limited to; empty = every file. */
  paths: string[];
  scope: "org" | "repo" | "config";
  /** What the rule is about (R6.11); absent for openreview.json rules. */
  category?: RuleCategory;
  /** Default severity of a violation, and the minimum severity of a finding that cites the rule (R6.11). */
  severity?: RuleSeverity;
  /** Extra context and examples for reviewers. */
  instructions?: string;
}

const matchers = new Map<string, (p: string) => boolean>();

export function globMatch(globs: string[], path: string): boolean {
  if (globs.length === 0) return true;
  const key = globs.join("\0");
  let m = matchers.get(key);
  if (!m) {
    m = picomatch(globs, { dot: true });
    matchers.set(key, m);
  }
  return m(path);
}

export function ruleApplies(rule: ReviewRule, path: string): boolean {
  return globMatch(rule.paths, path);
}

/** Rules relevant to a PR: those whose path scope matches at least one changed file. */
export function applicableRules(rules: ReviewRule[], changedPaths: string[]): ReviewRule[] {
  return rules.filter((r) => changedPaths.some((p) => ruleApplies(r, p)));
}

/**
 * A finding's severity after a cited rule's floor (R6.11): a finding that enforces a rule is never less severe than
 * the rule's severity.
 */
export function applySeverityFloor<S extends RuleSeverity>(severity: S, rule: Pick<ReviewRule, "severity"> | null | undefined): S | RuleSeverity {
  if (!rule?.severity) return severity;
  return SEVERITY_ORDER[rule.severity] < SEVERITY_ORDER[severity] ? rule.severity : severity;
}

/** One rule as a line (plus an indented instructions line) of the team-rules section of a prompt. */
export function renderRuleLine(r: ReviewRule): string {
  const meta = [
    r.category ? `category: ${r.category}` : null,
    r.severity ? `severity: ${r.severity}` : null,
    r.paths.length ? `applies to: ${r.paths.join(", ")}` : null,
  ].filter(Boolean);
  const line = `- [${r.id}]${meta.length ? ` (${meta.join("; ")})` : ""} ${r.text.replace(/\s*\n\s*/g, " ")}`;
  const instructions = r.instructions?.trim().replace(/\s*\n\s*/g, " ");
  return instructions ? `${line}\n  Instructions: ${instructions}` : line;
}

export function renderRulesSection(rules: ReviewRule[]): string {
  if (!rules.length) return "";
  return [
    "## Team rules",
    "The team requires these rules. Report violations in changed lines. When a finding enforces a rule, set ruleId to the",
    "rule's id in brackets (e.g. \"rule:12\"); a rule only applies to files matching its paths.",
    ...rules.map(renderRuleLine),
  ].join("\n");
}
