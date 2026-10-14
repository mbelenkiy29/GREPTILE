// Sample content for the landing page's replicas of real dashboard screens. The finding, evidence
// and summary follow the review engine's output on the cross-file fixture (reports/demo.json);
// analytics numbers are illustrative values for a demo workspace.
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
      "@@ -3,5 +3,5 @@ import { total } from \"../src/cart\";",
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
      { filePath: "src/billing.ts", startLine: 2, quote: "// Payment provider amount is integer cents." },
      { filePath: "src/billing.ts", startLine: 3, quote: "  return provider.charge({ amount: total(cart.priceInCents, cart.quantity), currency: \"USD\" });" },
    ],
  },
  {
    _id: "f2",
    severity: "medium",
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

export const diffFindings: DiffFinding[] = findings.map(({ _id, severity, title, filePath, startLine, endLine, description }) => ({ _id, severity, title, filePath, startLine, endLine, description }));

export const score = { value: 2, reason: "The change silently alters a unit that billing depends on; payments would be sent in the wrong unit." };

export const summary = `## Summary of changes
- **src/cart.ts:** \`total(cents, qty)\` now returns dollars (\`cents * qty / 100\`) instead of integer cents.
- **test/cart.test.ts:** the expectation was updated to the dollar value.

## Affected areas
- \`src/billing.ts\` calls \`total()\` and sends the result to the payment provider as integer cents.

## Recommendation
Request changes. Keep \`total()\` in cents and convert to dollars only where totals are displayed.`;

export const history = [
  { at: "Oct 14, 2026, 2:03 PM UTC", sha: "9f3c2e1a7b40d6c1", status: "completed", findings: 2, score: "2/5", current: true },
  { at: "Oct 14, 2026, 1:41 PM UTC", sha: "4b7d0a2c91e5f377", status: "completed", findings: 1, score: "3/5", current: false },
];

export const fixPrompt = `Fix verified OpenReview finding in acme/shop PR #42 (revision 9f3c2e1a):
[critical] src/cart.ts:4 total() now returns dollar value instead of cents…`;

export const chat = {
  question: "Where is the checkout total computed, and which callers depend on it?",
  askedAt: "Oct 14, 2026, 2:10 PM",
  answer: "Totals are computed by `total()` in integer cents [1], and `charge()` passes them straight to the payment provider [2]. Any change to the unit of `total()` changes what the provider is charged.",
  citations: [
    { ref: "acme/shop:src/cart.ts:2", quote: "  return cents * qty;" },
    { ref: "acme/shop:src/pay.ts:2", quote: "export const charge = (c: number) => provider.charge({ amount: total(c, 1) });" },
  ],
  threads: ["Where is the checkout total computed?", "How is the review budget enforced?", "Which webhooks start a review?"],
};

export const analytics = {
  metrics: [["Total PRs", "24"], ["Total Reviews", "37"], ["Verified findings", "19"], ["Model cost", "$6.82"]] as const,
  days: ["10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07", "10-08", "10-09", "10-10", "10-11", "10-12", "10-13", "10-14"],
  reviews: [2, 3, 1, 4, 2, 0, 0, 3, 5, 2, 4, 6, 3, 2],
  findings: [1, 2, 0, 2, 1, 0, 0, 1, 3, 1, 2, 4, 1, 1],
  addressed: [0, 1, 0, 1, 1, 0, 0, 1, 2, 1, 1, 2, 1, 1],
  severity: [["critical", 2], ["high", 5], ["medium", 8], ["low", 4]] as const,
};
