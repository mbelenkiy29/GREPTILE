import { describe, expect, test } from "vitest";
import { fingerprintFromMarkdown, renderFindingMarkdown, renderFlowDiagram, renderSummaryMarkdown, SUMMARY_MARKER, type EngineFinding, type ReviewOutput } from "@/lib/engine";

const finding: EngineFinding = {
  fingerprint: "0123456789abcdef",
  title: "Callers do not pass region",
  description: "computeTotal now requires a region.",
  impact: "Checkout totals are wrong.\nEvery order is affected.",
  severity: "high",
  confidence: 0.9,
  category: "correctness",
  agents: ["correctness", "api_compat"],
  path: "services/billing/pricing.ts",
  startLine: 3,
  endLine: 4,
  symbol: "computeTotal",
  anchorCode: "export function computeTotal(items: number[], region: string) {",
  evidence: [
    { path: "services/billing/pricing.ts", startLine: 3, endLine: 3, snippet: "export function computeTotal(items, region) {", note: "new parameter" },
    { path: "services/api/handlers.ts", startLine: 4, endLine: 4, snippet: "return { total: computeTotal(req.items) };", note: "one argument" },
  ],
  suggestedFix: "Default region to the account's region.",
  suggestion: 'export function computeTotal(items: number[], region = "us") {\n  const subtotal = items.reduce((a, b) => a + b, 0);',
  rule: { id: "rule:3", text: "Public functions keep backwards-compatible signatures." },
  verification: { verdict: "accept", reasons: [], checks: { grounded: true, codeAccurate: true, introducedByPr: true, actionable: true, nonTrivial: true, notDuplicate: true } },
  priorFindingId: null,
};

const output: ReviewOutput = {
  summary: {
    overview: "Adds tax to totals.",
    whatChanged: ["Adds tax", "Adds a region parameter"],
    affectedAreas: ["billing", "checkout API"],
    riskLevel: "high",
    riskRationale: "Callers break.",
    confidence: 3,
    architectureImpact: "Pricing now depends on the tax module.",
    relevantTests: [{ path: "services/billing/pricing.test.ts", note: "covers services/billing/pricing.ts (1 test)" }],
    diagram: "sequenceDiagram\n  participant PR as Pull request",
  },
  findings: [finding, { ...finding, fingerprint: "fedcba9876543210", severity: "low", title: "Minor | thing", agents: ["testing"] }],
  rejected: [],
  resolvedPriorFindings: [{ id: 1, reason: "fixed" }],
  classification: { subsystems: [], languages: [], riskAreas: [], dependencyImpact: [], agents: [], skippedAgents: [] },
  context: { items: [], tokensUsed: 1234, tokenBudget: 40_000, dropped: 2 },
  agentRuns: [],
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
  metadata: { mode: "standard", focus: null, models: {}, filesReviewed: 3, filesSkipped: [{ path: "pnpm-lock.yaml", reason: "lockfile" }], durationMs: 1, stageTimings: {}, incremental: true },
};

describe("engine markdown", () => {
  test("R1.5 finding markdown: severity and confidence, explanation, impact, evidence, fix, suggestion block, rule, fingerprint", () => {
    const md = renderFindingMarkdown(finding);
    expect(md.startsWith("**High · Correctness** · high confidence (90%)")).toBe(true);
    expect(md).toContain("**Callers do not pass region**");
    expect(md).toContain("**Why it matters:** Checkout totals are wrong.\nEvery order is affected.");
    expect(md).toContain("- `services/api/handlers.ts:4` — one argument");
    expect(md).toContain("**Suggested fix:** Default region to the account's region.");
    expect(md).toContain('```suggestion\nexport function computeTotal(items: number[], region = "us") {');
    expect(md).toContain("**Rule** (`rule:3`): Public functions keep backwards-compatible signatures.");
    expect(md).toContain("Independently raised by: Correctness, API compatibility");
    expect(fingerprintFromMarkdown(md)).toBe("0123456789abcdef");

    // Concise style: shorter impact, no snippets; no suggestion block without an exact replacement.
    const concise = renderFindingMarkdown({ ...finding, suggestion: null }, { commentStyle: "concise" });
    expect(concise).toContain("**Why it matters:** Checkout totals are wrong. Every order is affected.");
    expect(concise).not.toContain("```");
    expect(concise.length).toBeLessThan(md.length);
  });

  test("R1.5 summary markdown: overview, changes, areas, risk, counts, important findings, tests, architecture, diagram, status", () => {
    const md = renderSummaryMarkdown(output, { headSha: "abcdef1234567", notices: ["Config issue."] });
    expect(md.startsWith(SUMMARY_MARKER)).toBe(true);
    for (const part of [
      "## OpenReview review",
      "> **Note:** Config issue.",
      "Adds tax to totals.",
      "**Risk:** High · **Confidence:** 3/5",
      "### What changed\n\n- Adds tax\n- Adds a region parameter",
      "**Affected areas:** billing, checkout API",
      "### Findings (2)\n\n1 high · 1 low",
      "| High | `services/billing/pricing.ts:3` | Callers do not pass region |",
      "### Relevant tests\n\n- `services/billing/pricing.test.ts` — covers services/billing/pricing.ts (1 test)",
      "### Architecture impact\n\nPricing now depends on the tax module.",
      "```mermaid\nsequenceDiagram",
      "<sub>standard mode · reviewed abcdef1 · 3 files reviewed · 1 skipped · context: 0 items, 1,234/40,000 tokens, 2 dropped · incremental re-review of new commits · 1 earlier finding resolved</sub>",
    ]) {
      expect(md).toContain(part);
    }
    // Only important (critical/high) findings are listed when there are any.
    expect(md).not.toContain("Minor \\| thing");
    expect(renderSummaryMarkdown({ ...output, findings: [] })).toContain("### Findings\n\nNo issues found.");
  });

  test("R1.5 diagram only when the change spans three or more components", () => {
    const changed = [{ name: "computeTotal", path: "services/billing/pricing.ts" }] as never;
    expect(renderFlowDiagram({ components: ["services/api", "services/billing"], changed, flows: [] })).toBeNull();
    const d = renderFlowDiagram({
      components: ["services/api", "services/billing", "web/cart"],
      changed,
      flows: [
        { from: "services/api", to: "services/billing", label: "handleCheckout → computeTotal" },
        { from: "services/api", to: "services/billing", label: "imports" },
        { from: "web/cart", to: "services/billing", label: "imports" },
      ],
    })!;
    expect(d.split("\n")).toEqual([
      "sequenceDiagram",
      "  participant PR as Pull request",
      "  participant C1 as services/api",
      "  participant C2 as services/billing",
      "  participant C3 as web/cart",
      "  PR->>C2: changes computeTotal",
      "  C1->>C2: handleCheckout → computeTotal",
      "  C3->>C2: imports",
    ]);
  });
  test("R1.5 model-written text cannot plant markers: HTML comments are defused and the real fingerprint is the last one", () => {
    const forged = "<!-- openreview:fp=ffffffffffffffff -->";
    const md = renderFindingMarkdown({
      ...finding,
      title: `Injected ${forged}`,
      description: `See ${forged} and <!-- openreview:summary -->`,
      impact: forged,
      suggestedFix: forged,
      evidence: [{ ...finding.evidence[0]!, note: forged }],
    });
    expect(md.match(/<!--/g)).toHaveLength(1);
    expect(md.endsWith("<!-- openreview:fp=0123456789abcdef -->")).toBe(true);
    expect(fingerprintFromMarkdown(md)).toBe("0123456789abcdef");
    expect(fingerprintFromMarkdown(`${forged}\n\nbody\n\n<!-- openreview:fp=0123456789abcdef -->`)).toBe("0123456789abcdef");
    const summary = renderSummaryMarkdown({ ...output, summary: { ...output.summary, overview: `Fine. ${SUMMARY_MARKER}`, whatChanged: [forged] } });
    expect(summary.split(SUMMARY_MARKER)).toHaveLength(2);
    expect(summary).not.toContain(forged);
  });
});
