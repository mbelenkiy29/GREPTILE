// Sample content for the landing page's interactive replicas of real dashboard screens. The
// finding, evidence and summary follow the review engine's output on the cross-file fixture
// (reports/demo.json); everything else (other pull requests, chat answers, rules, analytics) is
// illustrative content for a demo workspace.
import type { DiffFile, DiffFinding } from "../dashboard/diff-files";

export const pull = {
  repo: "acme/shop",
  number: 42,
  title: "Show cart totals in dollars",
  author: "dana",
  head: "9f3c2e1a7b40d6c1",
  headBranch: "feature/dollar-totals",
  baseBranch: "main",
  provider: "GitHub · Acme · github.com · Repository ID 482113",
  reviewedAt: "Oct 14, 2026, 2:03 PM UTC",
};
/** The default branch revision the repository was indexed at; chat answers cite it. */
export const indexed = "5d1e0b7c3a9f2e48";

export const diffFiles: DiffFile[] = [
  {
    path: "src/cart.ts",
    status: "modified",
    truncated: false,
    patch: [
      "@@ -1,6 +1,7 @@",
      " // Cart arithmetic. Prices are stored as integer cents.",
      " export function total(cents: number, qty: number) {",
      "-  return cents * qty;",
      "+  // Show totals in dollars.",
      "+  return (cents * qty) / 100;",
      " }",
      " ",
      " export function itemCount(lines: { qty: number }[]) {",
    ].join("\n"),
  },
  {
    path: "test/cart.test.ts",
    status: "modified",
    truncated: false,
    patch: [
      "@@ -3,3 +3,3 @@ import { total } from \"../src/cart\";",
      " test(\"total multiplies price by quantity\", () => {",
      "-  assert.equal(total(1250, 2), 2500);",
      "+  assert.equal(total(1250, 2), 25);",
      " });",
    ].join("\n"),
  },
];

export const findings = [
  {
    _id: "f1",
    severity: "critical",
    category: "correctness",
    title: "total() now returns dollar value instead of cents, breaking charge() expectations",
    filePath: "src/cart.ts",
    startLine: 4,
    endLine: 4,
    confidence: 0.95,
    description: "total() now divides by 100 and returns a dollar value, but charge() in src/billing.ts still passes it to the payment provider as amount, which its own comment says is integer cents.",
    impact: "Payments would be sent in the wrong unit: a $25.00 cart is charged as 25 cents, or rejected as a non-integer amount.",
    suggestedFix: "Keep total() in cents and format dollars where totals are displayed, or convert back to cents in charge() before calling the provider.",
    evidence: [
      { filePath: "src/cart.ts", startLine: 4, quote: "  return (cents * qty) / 100;" },
      { filePath: "src/billing.ts", startLine: 4, quote: "// Payment provider amount is integer cents." },
      { filePath: "src/billing.ts", startLine: 6, quote: "  return provider.charge({ amount: total(cart.priceInCents, cart.quantity), currency: \"USD\" });" },
    ],
  },
  {
    _id: "f2",
    severity: "medium",
    category: "testing",
    title: "Updated test asserts the dollar value, so the billing regression passes CI",
    filePath: "test/cart.test.ts",
    startLine: 4,
    endLine: 4,
    confidence: 0.82,
    description: "The expectation was changed to match the new unit. No test covers charge(), so the suite stays green while the provider receives dollars.",
    impact: "The regression would ship without a failing check.",
    suggestedFix: "Add a charge() test that asserts the provider receives integer cents.",
    evidence: [{ filePath: "test/cart.test.ts", startLine: 4, quote: "  assert.equal(total(1250, 2), 25);" }],
  },
];

/** Files at the reviewed revision, so a quoted line can be shown in place. */
export const sources: Record<string, string[]> = {
  "src/cart.ts": [
    "// Cart arithmetic. Prices are stored as integer cents.",
    "export function total(cents: number, qty: number) {",
    "  // Show totals in dollars.",
    "  return (cents * qty) / 100;",
    "}",
    "",
    "export function itemCount(lines: { qty: number }[]) {",
    "  return lines.reduce((n, line) => n + line.qty, 0);",
    "}",
  ],
  "src/billing.ts": [
    "import { total } from \"./cart\";",
    "import { provider } from \"./provider\";",
    "",
    "// Payment provider amount is integer cents.",
    "export function charge(cart: Cart) {",
    "  return provider.charge({ amount: total(cart.priceInCents, cart.quantity), currency: \"USD\" });",
    "}",
  ],
  "test/cart.test.ts": [
    "import assert from \"node:assert/strict\";",
    "import { total } from \"../src/cart\";",
    "test(\"total multiplies price by quantity\", () => {",
    "  assert.equal(total(1250, 2), 25);",
    "});",
  ],
};

export const diffFindings: DiffFinding[] = findings.map(({ _id, severity, title, filePath, startLine, endLine, description }) => ({ _id, severity, title, filePath, startLine, endLine, description }));

export const score = { value: 2, reason: "The change silently alters a unit that billing depends on; payments would be sent in the wrong unit." };

export const summary = `## Summary of changes
- **src/cart.ts:** \`total(cents, qty)\` now returns dollars (\`cents * qty / 100\`) instead of integer cents.
- **test/cart.test.ts:** the expectation was updated to the dollar value.

## Affected areas
- \`src/billing.ts\` calls \`total()\` and sends the result to the payment provider as integer cents.

## Recommendation
Request changes. Keep \`total()\` in cents and convert to dollars only where totals are displayed.`;

export type Revision = { at: string; sha: string; status: string; findings: number; score: string; summary: string };
export const history: Revision[] = [
  { at: "Oct 14, 2026, 2:03 PM UTC", sha: "9f3c2e1a7b40d6c1", status: "completed", findings: 2, score: "2/5", summary },
  { at: "Oct 14, 2026, 1:41 PM UTC", sha: "4b7d0a2c91e5f377", status: "completed", findings: 1, score: "3/5", summary: `## Summary of changes
- **src/cart.ts:** \`total(cents, qty)\` now returns dollars (\`cents * qty / 100\`) instead of integer cents.

## Affected areas
- \`src/billing.ts\` calls \`total()\` and sends the result to the payment provider as integer cents.

## Recommendation
Request changes. The existing test in \`test/cart.test.ts\` still expects cents and will fail.` },
];

/** The fix @dana pushes after the review; re-reviewing it in the demo resolves both findings. */
export const fixPush = {
  sha: "c41e8d03b2a95f17",
  message: "Keep totals in cents and format them for display",
  revision: { at: "Oct 14, 2026, 2:26 PM UTC", sha: "c41e8d03b2a95f17", status: "completed", findings: 0, score: "5/5", summary: `## Summary of changes
- **src/cart.ts:** \`total()\` returns integer cents again; a new \`formatDollars()\` formats totals for display.
- **test/cart.test.ts:** asserts cents again and adds a test for \`formatDollars()\`.

## Resolved since the last review
- \`total()\` no longer changes the unit that \`charge()\` sends to the payment provider.
- The test that hid the billing regression asserts integer cents again.

## Recommendation
Safe to merge.` } satisfies Revision,
  steps: ["Fetching c41e8d0 and the base revision", "Reading the change against the last review", "Checking callers of total() in src/billing.ts", "Verifying earlier findings against the new code", "Updating the summary comment"],
};

export const fixPrompt = `Fix verified OpenReview finding in acme/shop PR #42 (revision 9f3c2e1a):
[critical] src/cart.ts:4 total() now returns dollar value instead of cents…`;

/** The fix hand-off statuses, in the order the dashboard's Fix button reports them. */
export const fixStatuses = [
  "Waiting for your local bridge.",
  "Bridge claimed the request; waiting for launch confirmation.",
  "Agent launched.",
  "Agent exited successfully. Review its diff and test output.",
];
export const agents = [["codex", "Codex"], ["claude", "Claude Code"], ["cursor", "Cursor Agent"]] as const;

/** Other pull requests on the demo's list page: one reviewed without findings, one still running. */
export type OtherPull = { number: number; title: string; author: string; head: string; headBranch: string; reviewedAt: string; status: string; score?: { value: number; reason: string }; files?: DiffFile[]; steps?: string[] };
export const otherPulls: OtherPull[] = [
  {
    number: 41, title: "Retry webhook deliveries with backoff", author: "sam", head: "e07a5c19d3b2f846", headBranch: "fix/webhook-retries", reviewedAt: "Oct 14, 2026, 11:20 AM UTC", status: "completed",
    score: { value: 5, reason: "A contained change with a test for each retry path; no callers depend on the old behaviour." },
    files: [{
      path: "src/webhooks/deliver.ts", status: "modified", truncated: false,
      patch: [
        "@@ -8,7 +8,10 @@ export async function deliver(event: WebhookEvent) {",
        "   const response = await post(event.url, event.body);",
        "-  if (!response.ok) throw new Error(`Delivery failed: ${response.status}`);",
        "+  if (!response.ok) {",
        "+    if (event.attempt >= 5) return markFailed(event);",
        "+    return schedule(event, backoff(event.attempt));",
        "+  }",
        "   return markDelivered(event);",
        " }",
      ].join("\n"),
    }],
  },
  {
    number: 40, title: "Add currency to invoice export", author: "lee", head: "71b9e2d04c8a6f35", headBranch: "feature/invoice-currency", reviewedAt: "", status: "running",
    steps: ["Indexed acme/shop at 5d1e0b7", "Reading 3 changed files", "Following callers of exportInvoices()"],
  },
];

export const chat = {
  askedAt: "Oct 14, 2026, 2:10 PM",
  answers: [
    {
      question: "Where is the checkout total computed, and which callers depend on it?",
      keywords: ["total", "checkout", "cart", "computed", "caller", "price"],
      steps: ["Searching acme/shop for total(", "Reading src/cart.ts", "Following callers of total()", "Reading src/billing.ts", "Checking citations against 5d1e0b7"],
      answer: "Totals are computed by `total()` in integer cents [1], and `charge()` passes them straight to the payment provider [2]. Any change to the unit of `total()` changes what the provider is charged.",
      citations: [
        { ref: "acme/shop:src/cart.ts:3", quote: "  return cents * qty;" },
        { ref: "acme/shop:src/billing.ts:6", quote: "  return provider.charge({ amount: total(cart.priceInCents, cart.quantity), currency: \"USD\" });" },
      ],
    },
    {
      question: "Which tests cover charge()?",
      keywords: ["test", "coverage", "cover", "charge"],
      steps: ["Searching acme/shop for charge(", "Listing test files that import src/billing.ts", "Reading test/cart.test.ts", "Checking citations against 5d1e0b7"],
      answer: "None call it directly. `test/cart.test.ts` covers `total()` only [1], and `charge()` [2] has no test, so a change to the unit of `total()` would not fail CI.",
      citations: [
        { ref: "acme/shop:test/cart.test.ts:4", quote: "  assert.equal(total(1250, 2), 2500);" },
        { ref: "acme/shop:src/billing.ts:6", quote: "  return provider.charge({ amount: total(cart.priceInCents, cart.quantity), currency: \"USD\" });" },
      ],
    },
    {
      question: "What happens when a payment webhook fails?",
      keywords: ["webhook", "fail", "retr", "payment", "signature"],
      steps: ["Searching acme/shop for webhook handlers", "Reading src/webhooks/payment.ts", "Checking citations against 5d1e0b7"],
      answer: "`handlePayment()` checks the signature first and answers 400 when it does not match [1]. Errors after that are rethrown, so the provider retries the delivery [2]; the handler does not retry on its own.",
      citations: [
        { ref: "acme/shop:src/webhooks/payment.ts:4", quote: "  if (!verifySignature(request)) return new Response(\"bad signature\", { status: 400 });" },
        { ref: "acme/shop:src/webhooks/payment.ts:11", quote: "    throw error; // a non-2xx answer makes the provider retry" },
      ],
    },
  ],
  fallback: "This demo answers a few sample questions about acme/shop. Sign in and index a repository to ask about your own code.",
};

export type Rule = { id: string; title: string; body: string; scope: string; by: string; on: boolean };
export const memory = {
  rules: [
    { id: "cents", title: "Money is integer cents", body: "Flag arithmetic that turns cents into dollars outside the formatting helpers in src/format.ts.", scope: "src/**", by: "dana", on: true },
    { id: "webhooks", title: "Webhook handlers verify signatures first", body: "Every handler in src/webhooks must call verifySignature() before reading the body.", scope: "src/webhooks/**", by: "sam", on: true },
    { id: "migrations", title: "Migrations are additive", body: "Never drop or rename a column in the same migration that stops using it.", scope: "db/migrations/**", by: "lee", on: false },
  ] satisfies Rule[],
  preferences: [
    { id: "returns", text: "Prefer early returns to nested conditionals in request handlers.", source: "Learned from 6 review comments by @dana and @sam" },
    { id: "jsdoc", text: "Don't ask for doc comments on unexported helpers.", source: "Learned from 4 thumbs-down reactions" },
  ],
};

const day = (n: number) => `10-${String(n).padStart(2, "0")}`;
export const analytics = {
  days: Array.from({ length: 14 }, (_, i) => day(i + 1)),
  // Daily counts per repository; findings are listed by severity so every total adds up.
  repositories: {
    "acme/shop": {
      pulls: [1, 1, 1, 1, 1, 0, 0, 1, 2, 1, 1, 2, 1, 1],
      reviews: [1, 2, 1, 2, 1, 0, 0, 2, 3, 1, 2, 4, 2, 1],
      findings: [["medium"], ["high"], [], ["low"], ["medium"], [], [], ["critical"], ["medium", "high"], ["low"], ["medium"], ["critical", "high", "medium"], ["medium"], ["low"]],
      addressed: [0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0],
      costPerReview: 0.21,
    },
    "acme/api": {
      pulls: [1, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 1],
      reviews: [1, 1, 0, 2, 1, 0, 0, 1, 2, 1, 2, 2, 1, 1],
      findings: [[], ["medium"], [], ["low"], [], [], [], [], ["high"], [], ["medium"], ["high"], [], []],
      addressed: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1],
      costPerReview: 0.14,
    },
  } as Record<string, { pulls: number[]; reviews: number[]; findings: string[][]; addressed: number[]; costPerReview: number }>,
};
