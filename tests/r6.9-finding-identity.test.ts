import { afterEach, describe, expect, test } from "vitest";
import { anchorCodeOf, fingerprint, normalizeCode, renderSummaryMarkdown, runReview, type PriorFinding } from "@/lib/engine";
import { agentOf, callerBug, engineLlm, engineRequest, PRICING, readAt, SETTINGS, type Fixture } from "./helpers/engine";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";

let fx: Fixture | undefined;
afterEach(() => {
  fx?.fixture.cleanup();
  fx = undefined;
});

const base = { category: "correctness", path: PRICING, symbol: "computeTotal", title: "Callers do not pass the region argument" };

function prior(id: number, over: Partial<PriorFinding> = {}): PriorFinding {
  return {
    id,
    fingerprint: `${String(id).padStart(2, "0")}${"ab".repeat(7)}`,
    title: `Prior problem ${id}`,
    description: "An earlier finding.",
    category: "correctness",
    severity: "medium",
    path: PRICING,
    startLine: 4,
    endLine: 4,
    anchorCode: "const subtotal = items.reduce((a, b) => a + b, 0);",
    symbol: "computeTotal",
    ...over,
  };
}

describe("finding identity and lifecycle", () => {
  test("R6.9 fingerprints ignore line numbers and whitespace but not what the finding is about", () => {
    const code = "export function computeTotal(items: number[], region: string) {";
    const fp = fingerprint({ ...base, anchorCode: normalizeCode(code) });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // Same code reformatted, moved to another line, and the title reworded in another order.
    const moved = `// a new header comment\n\n\n  export   function computeTotal(items:number[],region:string){\n`;
    expect(anchorCodeOf(moved, 4, 4)).toBe("export function computeTotal(items:number[],region:string){");
    expect(fingerprint({ ...base, anchorCode: anchorCodeOf(moved, 4, 4) })).toBe(fp);
    expect(fingerprint({ ...base, title: "The region argument: callers do not pass", anchorCode: code })).toBe(fp);
    // Anything substantive changes it.
    expect(fingerprint({ ...base, anchorCode: code, category: "security" })).not.toBe(fp);
    expect(fingerprint({ ...base, anchorCode: code, path: "other.ts" })).not.toBe(fp);
    expect(fingerprint({ ...base, anchorCode: code, symbol: null })).not.toBe(fp);
    expect(fingerprint({ ...base, anchorCode: code.replace("region", "zone") })).not.toBe(fp);
    expect(fingerprint({ ...base, anchorCode: code, title: "Tax is rounded twice" })).not.toBe(fp);
  });

  test("R6.9 the same finding after a push that moves lines keeps its fingerprint", async () => {
    fx = await reviewFixture();
    const llm = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug()] : [] }) });
    const first = await runReview({ db: fx.db, llm }, await engineRequest(fx));
    fx.fixture.cleanup();

    const shifted = `// Pricing with tax.\n// Regions arrive in a later change.\n${HEAD_PRICING.replace("export function computeTotal(items: number[], region: string) {", "export function computeTotal( items: number[],  region: string ) {")}`;
    fx = await reviewFixture({ headExtra: { [PRICING]: shifted } });
    const moved = await runReview(
      { db: fx.db, llm: engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug({ startLine: 5, endLine: 5, evidence: [{ ...callerBug().evidence[0]!, startLine: 5, endLine: 5, snippet: "export function computeTotal( items: number[],  region: string ) {" }] })] : [] }) }) },
      await engineRequest(fx),
    );
    expect(first.findings[0]!.startLine).toBe(3);
    expect(moved.findings[0]!.startLine).toBe(5);
    expect(moved.findings[0]!.fingerprint).toBe(first.findings[0]!.fingerprint);
    expect(moved.findings[0]!.anchorCode).toBe("export function computeTotal( items: number[], region: string ) {");
  });

  test("R6.9 a candidate matching an open prior finding reuses its fingerprint and links priorFindingId", async () => {
    fx = await reviewFixture();
    const llm = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug({ startLine: 4, endLine: 4, title: "Prior problem 7 still here", evidence: [{ path: PRICING, startLine: 4, endLine: 4, snippet: "const subtotal = items.reduce((a, b) => a + b, 0);", why: "x" }] })] : [] }) });
    const p = prior(7);
    const out = await runReview(
      { db: fx.db, llm },
      // Our own earlier comment for that finding is on the PR; the match is tracked, not rejected as a repeat.
      await engineRequest(fx, { priorFindings: [p], existingComments: [{ id: 5, author: "openreview[bot]", body: "Prior problem 7", path: PRICING, line: 4, fingerprint: p.fingerprint }] }),
    );
    expect(out.findings.map((f) => [f.fingerprint, f.priorFindingId])).toEqual([[p.fingerprint, 7]]);
    expect(out.resolvedPriorFindings).toEqual([]);
    // Same path + same symbol + similar title also matches when the anchor code changed.
    const llm2 = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug({ title: "Prior problem 8 still here" })] : [] }) });
    const out2 = await runReview({ db: fx.db, llm: llm2 }, await engineRequest(fx, { priorFindings: [prior(8, { anchorCode: "something else entirely" })] }));
    expect(out2.findings[0]!.priorFindingId).toBe(8);
  });

  test("R6.9 resolution: fixed, unfixed, untouched, and deleted-anchor prior findings in an incremental re-review", async () => {
    fx = await reviewFixture();
    const priors = [
      prior(1, { title: "Subtotal ignores discounts" }),
      prior(2, { title: "Subtotal can be negative" }),
      prior(3, { path: "web/cart/summary.ts", anchorCode: 'return "Total: " + computeTotal(items);', symbol: "renderSummary" }),
      prior(4, { anchorCode: "return items.reduce((a, b) => a + b, 0);", symbol: "legacyTotal" }),
    ];
    const llm = engineLlm({ resolve: () => ({ results: [{ id: "1", fixed: true, reason: "Discounts are now applied before tax." }, { id: "2", fixed: false, reason: "Still unchecked." }] }) });
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx, { priorFindings: priors, incremental: { sinceSha: fx.base, changedPaths: [PRICING] } }));
    expect(out.resolvedPriorFindings).toEqual([
      { id: 1, reason: "Discounts are now applied before tax." },
      { id: 4, reason: "the anchored code and legacyTotal were removed" },
    ]);
    const resolver = llm.calls.filter((c) => agentOf(c) === "resolver");
    expect(resolver).toHaveLength(1);
    expect(resolver[0]!.req).toMatchObject({ task: "verify", cache: true });
    expect([...resolver[0]!.req.prompt.matchAll(/<prior_finding nonce="[0-9a-f]+" id="(\d+)"/g)].map((m) => m[1])).toEqual(["1", "2"]);
    expect(resolver[0]!.req.prompt).toMatch(/<current_code nonce="[0-9a-f]+" id="1" path="services\/billing\/pricing.ts">\nexport function computeTotal/);
    expect(out.metadata.incremental).toBe(true);
    expect(out.agentRuns.find((r) => r.agent === "resolver")).toMatchObject({ status: "ok", candidates: 2, accepted: 1 });
  });

  test("R6.9 incremental re-review only sends files changed since the last review to agents; the summary covers the whole PR", async () => {
    fx = await reviewFixture({ headExtra: { "web/cart/summary.ts": `import { computeTotal } from "../../services/billing/pricing";\n\nexport function renderSummary(items: number[]) {\n  return "Total: " + computeTotal(items, "eu");\n}\n` } });
    const llm = engineLlm({
      review: (agent) => ({
        findings: agent === "correctness" ? [callerBug({ path: "web/cart/summary.ts", startLine: 4, endLine: 4, title: "Hard-coded region", evidence: [{ path: "web/cart/summary.ts", startLine: 4, endLine: 4, snippet: 'return "Total: " + computeTotal(items, "eu");', why: "x" }] })] : [],
      }),
    });
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx, { incremental: { sinceSha: fx.base, changedPaths: [PRICING] } }));
    const review = llm.calls.find((c) => c.req.task === "review")!.req.prompt;
    expect(review).toMatch(/<diff nonce="[0-9a-f]+" path="services\/billing\/pricing.ts" status="modified" role="review">/);
    expect(review).toMatch(/<diff nonce="[0-9a-f]+" path="web\/cart\/summary.ts" status="modified" role="context">/);
    expect(out.rejected).toEqual([expect.objectContaining({ title: "Hard-coded region", stage: "anchor", reason: "the file was not re-reviewed in this run (unchanged since the last review)" })]);
    expect(out.metadata.filesReviewed).toBe(1);
    const summary = llm.calls.find((c) => c.req.task === "summary")!.req.prompt;
    expect(summary).toContain("### web/cart/summary.ts (modified)");
    expect(summary).toContain("### services/billing/pricing.ts (modified)");
  });
  test("R6.9 incremental summary counts open prior findings in untouched files and caps confidence for them", async () => {
    fx = await reviewFixture();
    const open = prior(3, { title: "Cart total skips tax", severity: "critical", path: "web/cart/summary.ts", anchorCode: 'return "Total: " + computeTotal(items);', symbol: "renderSummary", startLine: 4, endLine: 4 });
    const llm = engineLlm();
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx, { priorFindings: [open], incremental: { sinceSha: fx.base, changedPaths: [PRICING] } }));
    expect(out.findings).toEqual([]);
    expect(out.resolvedPriorFindings).toEqual([]);
    expect(out.openPriorFindings).toEqual([{ id: 3, title: "Cart total skips tax", severity: "critical", category: "correctness", path: "web/cart/summary.ts", startLine: 4 }]);
    // The model said 4; an open critical finding caps it at 3.
    expect(out.summary.confidence).toBe(3);
    expect(llm.calls.find((c) => c.req.task === "summary")!.req.prompt).toContain("[critical] web/cart/summary.ts:4 Cart total skips tax (raised in an earlier review, still open)");
    const md = renderSummaryMarkdown(out);
    expect(md).not.toContain("No issues found");
    expect(md).toContain("### Findings (1)");
    expect(md).toContain("0 from this review, 1 still open from earlier reviews");
    expect(md).toContain("| Critical | `web/cart/summary.ts:4` | Cart total skips tax |");
  });

  test("R6.9 prior findings on a renamed file follow the rename and are resolved there", async () => {
    fx = await reviewFixture();
    const req = await engineRequest(fx);
    const moved = "services/billing/prices.ts";
    const files = req.files.map((f) => (f.path === PRICING ? { ...f, path: moved, previousPath: PRICING, status: "renamed" as const } : f));
    const llm = engineLlm();
    const out = await runReview(
      { db: fx.db, llm },
      {
        ...req,
        files,
        readFile: async (file, ref) => (file === moved ? (ref === "head" ? readAt(fx!.fixture, fx!.head, PRICING) : null) : req.readFile(file, ref)),
        priorFindings: [prior(4, { anchorCode: "return items.reduce((a, b) => a + b, 0);", symbol: "legacyTotal" })],
      },
    );
    expect(out.resolvedPriorFindings).toEqual([{ id: 4, reason: "the anchored code and legacyTotal were removed" }]);
    expect(out.openPriorFindings).toEqual([]);
  });
  test("R6.9 a duplicate merged into a finding that repeats a prior finding takes the prior's fingerprint and id", async () => {
    fx = await reviewFixture();
    const description = "The subtotal is computed before discounts are applied, so totals are overstated for every discounted order.";
    const strong = callerBug({ startLine: 5, endLine: 5, title: "Subtotal rounding drops cents", description, severity: "critical", confidence: 0.95, evidence: [{ path: PRICING, startLine: 5, endLine: 5, snippet: "return subtotal + taxFor(subtotal);", why: "x" }] });
    const repeat = callerBug({ startLine: 4, endLine: 4, title: "Prior problem 7 still here", description, severity: "medium", confidence: 0.7, evidence: [{ path: PRICING, startLine: 4, endLine: 4, snippet: "const subtotal = items.reduce((a, b) => a + b, 0);", why: "x" }] });
    const llm = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [strong, repeat] : [] }) });
    const p = prior(7);
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx, { priorFindings: [p], settings: { ...SETTINGS, model: "custom/judge-model" } }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ title: "Subtotal rounding drops cents", priorFindingId: 7, fingerprint: p.fingerprint });
    expect(out.rejected).toEqual([expect.objectContaining({ title: "Prior problem 7 still here", stage: "duplicate" })]);
    expect(out.openPriorFindings).toEqual([]);
    // The repository's model override reaches the judge as well as the reviewers.
    for (const c of llm.calls.filter((c) => c.req.task === "verify" || c.req.task === "review")) expect(c.req.model).toBe("custom/judge-model");
  });
});
