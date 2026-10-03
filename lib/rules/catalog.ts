/**
 * Rule vocabulary (R6.11) shared by the data layer, the engine, and the dashboard. Free of server imports so client
 * components can use it.
 */

export const RULE_CATEGORIES = ["correctness", "security", "data", "api_compat", "testing", "performance", "rules", "style"] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const RULE_CATEGORY_LABEL: Record<RuleCategory, string> = {
  correctness: "Correctness",
  security: "Security",
  data: "Data & migrations",
  api_compat: "API compatibility",
  testing: "Testing",
  performance: "Performance",
  rules: "Team convention",
  style: "Style",
};

export const RULE_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

/** 0 = most severe. */
export const SEVERITY_ORDER: Record<RuleSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const RULE_SEVERITY_HELP: Record<RuleSeverity, string> = {
  critical: "Must block the merge (data loss, security hole, outage).",
  high: "Likely bug or serious risk; fix before merging.",
  medium: "Should be fixed; worth a comment on every violation.",
  low: "Minor; mention it, but it can wait.",
};

/** Starter rules a team can add with one click (R6.11). Written for OpenReview; adjust them freely after adding. */
export interface RuleTemplate {
  id: string;
  title: string;
  text: string;
  category: RuleCategory;
  severity: RuleSeverity;
  paths: string[];
  instructions: string;
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: "api-org-membership",
    title: "API routes must verify organization membership",
    text: "Every API route handler that reads or writes organization data must check that the signed-in user belongs to that organization before touching the data.",
    category: "security",
    severity: "high",
    paths: ["app/api/**", "src/app/api/**", "pages/api/**"],
    instructions:
      "Look for handlers that take an organization or workspace id from the URL, query string, or body and query the database without first resolving the caller's membership. Taking the id from the session and filtering by it counts as a check.",
  },
  {
    id: "no-db-in-components",
    title: "No direct database calls from React components",
    text: "React components must not import the database client or run queries directly; data access goes through the data layer or server actions.",
    category: "correctness",
    severity: "medium",
    paths: ["components/**", "src/components/**", "**/*.tsx"],
    instructions: "Flag imports of the database client, ORM tables, or raw SQL helpers inside component files. Server components calling a data-layer function are fine.",
  },
  {
    id: "billing-tests",
    title: "Billing changes require tests",
    text: "Changes to billing, pricing, invoicing, or payment code must include or update automated tests that cover the changed behavior.",
    category: "testing",
    severity: "high",
    paths: ["**/billing/**", "**/payments/**", "**/pricing/**"],
    instructions: "Report when a pull request changes logic in these paths and no test file in the pull request exercises it. Pure renames and comment changes do not need tests.",
  },
  {
    id: "no-debug-logging",
    title: "No debug logging in production code",
    text: "Production code must not contain leftover debug output such as console.log, print statements, or debugger statements; use the structured logger instead.",
    category: "style",
    severity: "low",
    paths: [],
    instructions: "Ignore tests, scripts, command-line tools whose job is to print output, and examples in documentation.",
  },
];

export function ruleTemplate(id: string): RuleTemplate | undefined {
  return RULE_TEMPLATES.find((t) => t.id === id);
}

/** A rule's display title: its title, or the first sentence of its text for rules written before titles existed. */
export function ruleDisplayTitle(rule: { title: string; text: string }): string {
  if (rule.title.trim()) return rule.title.trim();
  const first = rule.text.trim().split(/(?<=[.!?])\s/)[0] ?? rule.text;
  return first.length > 100 ? `${first.slice(0, 97)}…` : first;
}
