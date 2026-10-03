/**
 * Copy for the public landing page (R5.1). Written for OpenReview; it describes what the code in this repository does
 * and makes no claims about results (no benchmark numbers, no customers, no testimonials). The example findings are
 * illustrative, written for a fictional repository, and always labeled as examples on the page.
 */
import type { FindingCategory, Severity } from "@/lib/engine/types";

export const HERO = {
  eyebrow: "Open source · AGPL-3.0 · Self-hostable",
  headline: "Code review that has read the rest of the codebase.",
  lede: "OpenReview reviews every pull request with the context around it — callers, dependents, tests, and your team's rules — and checks each finding against the code before it comments. Run it on your own server, with the model you choose.",
};

export interface PipelineStep {
  id: string;
  title: string;
  body: string;
}

export const PIPELINE_STEPS: readonly PipelineStep[] = [
  {
    id: "index",
    title: "Index the repository",
    body: "Files are parsed with tree-sitter into a graph of symbols, calls, and imports in PostgreSQL, with pgvector embeddings for search. Pushes to the default branch update it incrementally.",
  },
  {
    id: "understand",
    title: "Understand the change",
    body: "The diff is classified, then context is pulled from the graph: definitions of changed symbols, their callers and dependents, related tests, and the documents you marked as context.",
  },
  {
    id: "review",
    title: "Specialized reviewers, in parallel",
    body: "Correctness, security, data and migrations, API compatibility, testing, performance, and your own rules each get their own pass over the change.",
  },
  {
    id: "verify",
    title: "Verify every finding",
    body: "Each candidate is checked against the actual code before it can be posted. Duplicates are merged, and findings below your confidence and severity thresholds are held back.",
  },
  {
    id: "publish",
    title: "Publish to the pull request",
    body: "A summary with the risk level and a 1–5 confidence score, plus one inline comment per finding with a suggested change when there is an exact fix. New commits are reviewed incrementally.",
  },
  {
    id: "learn",
    title: "Learn from feedback",
    body: "Reactions, replies, and commands become preferences you can read and edit; your teammates' own review comments become candidate rules you approve.",
  },
];

export interface ExampleFinding {
  id: string;
  severity: Severity;
  confidence: number;
  category: FindingCategory;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Markdown, as the engine writes it. */
  description: string;
  impact: string;
  evidence: { path: string; startLine: number; note: string; snippet: string } | null;
  /** Unified diff of the suggested change. */
  suggestion: string | null;
  rule: string | null;
}

export const EXAMPLE_FINDINGS: readonly ExampleFinding[] = [
  {
    id: "callers",
    severity: "high",
    confidence: 0.92,
    category: "correctness",
    title: "Two callers of `computeTotal` were not updated for the new `region` parameter",
    path: "src/billing/pricing.ts",
    startLine: 14,
    endLine: 14,
    description:
      "This change makes `region` a required parameter of `computeTotal`, but `handleCheckout` in `src/checkout/handler.ts` and `renderCartSummary` in `src/cart/summary.tsx` still call it with only the line items. Neither file is part of this pull request.",
    impact: "Checkout and the cart summary would compute totals with `region` undefined, so the tax lookup falls back to zero.",
    evidence: {
      path: "src/checkout/handler.ts",
      startLine: 41,
      note: "Caller outside the diff, found through the call graph.",
      snippet: "const total = computeTotal(cart.items);",
    },
    suggestion: "@@ -41 +41 @@\n-const total = computeTotal(cart.items);\n+const total = computeTotal(cart.items, account.region);",
    rule: null,
  },
  {
    id: "authz",
    severity: "critical",
    confidence: 0.88,
    category: "security",
    title: "Organization id is taken from the request body without a membership check",
    path: "app/api/projects/route.ts",
    startLine: 22,
    endLine: 24,
    description:
      "`POST /api/projects` reads `orgId` from the JSON body and inserts into that organization. The handler never checks that the signed-in user belongs to it, so any user can create projects in any organization by changing the id.",
    impact: "Cross-tenant write: a user of one organization can create data inside another.",
    evidence: null,
    suggestion:
      "@@ -22,3 +22,3 @@\n-const { orgId, name } = await req.json();\n-await db.insert(projects).values({ orgId, name });\n+const { orgId } = await requireMembership(session); // from the session, not the body\n+const { name } = await req.json();\n+await db.insert(projects).values({ orgId, name });",
    rule: "API routes must verify organization membership",
  },
  {
    id: "migration",
    severity: "medium",
    confidence: 0.81,
    category: "data",
    title: "New NOT NULL column has no default, so the migration fails on existing rows",
    path: "db/migrations/0042_add_invoice_currency.sql",
    startLine: 3,
    endLine: 3,
    description:
      "`ALTER TABLE invoices ADD COLUMN currency text NOT NULL` will be rejected by PostgreSQL because `invoices` already has rows and the column has no default.",
    impact: "The deploy stops at this migration.",
    evidence: null,
    suggestion:
      "@@ -3 +3,2 @@\n-ALTER TABLE invoices ADD COLUMN currency text NOT NULL;\n+ALTER TABLE invoices ADD COLUMN currency text NOT NULL DEFAULT 'USD';\n+ALTER TABLE invoices ALTER COLUMN currency DROP DEFAULT;",
    rule: null,
  },
];

export interface Integration {
  id: string;
  name: string;
  body: string;
  href: string;
  icon: "github" | "gitlab" | "bitbucket" | "code" | "spark" | "source" | "settings";
}

export const INTEGRATIONS: readonly Integration[] = [
  { id: "github", name: "GitHub", body: "A GitHub App for github.com and GitHub Enterprise Server: reviews, suggestions, and @mentions.", href: "/docs/github-app", icon: "github" },
  { id: "gitlab", name: "GitLab", body: "Merge request discussions with suggestion blocks, on gitlab.com or self-managed.", href: "/docs/gitlab", icon: "gitlab" },
  { id: "bitbucket", name: "Bitbucket Cloud", body: "Inline pull request comments and threaded answers through an access token.", href: "/docs/bitbucket", icon: "bitbucket" },
  { id: "cli", name: "CLI", body: "Review your branch before you push, against your server or fully on your machine.", href: "/docs/cli", icon: "code" },
  { id: "mcp", name: "MCP server", body: "Findings, reviews, rules, and codebase search as tools for any MCP-capable agent.", href: "/docs/mcp", icon: "spark" },
  { id: "claude-code", name: "Claude Code plugin", body: "/openreview-fix and /openreview-loop: fix findings and iterate until the PR is clean.", href: "/docs/mcp", icon: "source" },
  { id: "api", name: "REST API", body: "Scoped API keys and an OpenAPI 3.1 document generated from the route table.", href: "/docs/api", icon: "settings" },
];

export interface FaqItem {
  q: string;
  a: string;
}

export const LANDING_FAQ: readonly FaqItem[] = [
  {
    q: "Is OpenReview free?",
    a: "Yes. It is free software under the GNU AGPL-3.0, and self-hosting it costs only your server and your model provider. Instances run by others may offer paid plans; see Pricing.",
  },
  {
    q: "Which models does it work with?",
    a: "Anthropic by default, plus OpenAI, OpenRouter, and any OpenAI-compatible endpoint — including models you run yourself. Each organization can bring its own provider and key.",
  },
  {
    q: "Does my code leave my server?",
    a: "Only as part of prompts to the model endpoint you configure. There is no telemetry. With a model on your network and the offline bundle, nothing leaves it at all.",
  },
  {
    q: "Will it bury my pull requests in comments?",
    a: "Every finding is verified against the code before it is posted, duplicates are merged, and you set the minimum confidence, minimum severity, and maximum number of comments. Feedback suppresses patterns your team does not want.",
  },
  {
    q: "Can a pull request manipulate the reviewer?",
    a: "Code, pull request text, and comments are always passed to the model as delimited data that cannot change instructions, settings, or rules. openreview.json is read from the base branch, and commands are only accepted from people with write access.",
  },
  {
    q: "What does a review cost?",
    a: "Reviews consume credits by mode (Fast, Standard, Deep), and every model call is recorded with its tokens and estimated cost, so you can see and cap spend per repository, author, and day.",
  },
];
