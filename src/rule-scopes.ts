import picomatch from "picomatch";

// Custom rule scopes: the whole workspace, one team's repositories, repositories whose full name
// matches a pattern (e.g. "acme/*-service"), or one repository. Existing rules keep their meaning:
// no scope field is the workspace and repositoryId is one repository.
export type RuleScope = "workspace" | "team" | "pattern" | "repository";
export type ScopedRule = { title: string; repositoryId?: string; teamId?: string; repositoryPattern?: string; createdAt?: number };
export const ruleScope = (r: ScopedRule): RuleScope => r.repositoryId ? "repository" : r.repositoryPattern ? "pattern" : r.teamId ? "team" : "workspace";
const specificity: Record<RuleScope, number> = { workspace: 0, team: 1, pattern: 2, repository: 3 };
export const validRepositoryPattern = (pattern: string) => pattern.length >= 3 && pattern.length <= 200 && /^[\w.\-*?{}[\],!]+\/[\w.\-*?{}[\],!/]+$/.test(pattern) && !pattern.split("/").some((part) => /^\.+$/.test(part));
export function ruleApplies(r: ScopedRule, repo: { _id: string; teamId?: string; fullName: string }) {
  switch (ruleScope(r)) {
    case "repository": return r.repositoryId === repo._id;
    case "pattern": return validRepositoryPattern(r.repositoryPattern!) && picomatch(r.repositoryPattern!, { nocase: true })(repo.fullName);
    case "team": return !!repo.teamId && r.teamId === repo.teamId;
    default: return true;
  }
}
// Rules for one repository: those that apply, with same-titled rules deduplicated so the most specific
// scope wins (repository > pattern > team > workspace; newest first on ties).
export function applicableRules<R extends ScopedRule>(rules: R[], repo: { _id: string; teamId?: string; fullName: string }): R[] {
  const byTitle = new Map<string, R>();
  for (const r of rules.filter((r) => ruleApplies(r, repo))) {
    const key = r.title.trim().toLowerCase(), held = byTitle.get(key);
    if (!held || specificity[ruleScope(r)] > specificity[ruleScope(held)] || (specificity[ruleScope(r)] === specificity[ruleScope(held)] && (r.createdAt ?? 0) > (held.createdAt ?? 0))) byTitle.set(key, r);
  }
  return [...byTitle.values()];
}
