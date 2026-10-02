import picomatch from "picomatch";

/** A rule as the review engine sees it, whatever its source (dashboard, openreview.json, mined). */
export interface ReviewRule {
  id: string;
  text: string;
  /** Glob paths the rule is limited to; empty = every file. */
  paths: string[];
  scope: "org" | "repo" | "config";
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

export function renderRulesSection(rules: ReviewRule[]): string {
  if (!rules.length) return "";
  const lines = rules.map((r) => `- [${r.id}]${r.paths.length ? ` (applies to: ${r.paths.join(", ")})` : ""} ${r.text}`);
  return [
    "## Team rules",
    "The team requires these rules. Report violations in changed lines. When a finding enforces a rule, set ruleId to the",
    "rule's id in brackets (e.g. \"rule:12\"); a rule only applies to files matching its paths.",
    ...lines,
  ].join("\n");
}
