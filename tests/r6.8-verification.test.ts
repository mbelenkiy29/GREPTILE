import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runReview } from "@/lib/engine";
import type { Candidate } from "@/lib/engine/agents";
import { rankScore } from "@/lib/engine/verify";
import type { FakeCall } from "@/lib/llm/fake";
import { agentOf, callerBug, engineLlm, engineRequest, judgedFindings, PRICING, SETTINGS, verdict, type Fixture } from "./helpers/engine";
import { reviewFixture } from "./helpers/review-fixture";

let fx: Fixture;
beforeAll(async () => {
  fx = await reviewFixture();
});
afterAll(() => fx.fixture.cleanup());

const L3 = "export function computeTotal(items: number[], region: string) {";
const L4 = "const subtotal = items.reduce((a, b) => a + b, 0);";
const L5 = "return subtotal + taxFor(subtotal);";

/** A candidate anchored at `line` of the PR's pricing.ts, with that line as its evidence. */
function at(line: number, snippet: string, over: Partial<Candidate>): Candidate {
  const title = over.title ?? "Untitled";
  return callerBug({
    startLine: line,
    endLine: line,
    symbol: null,
    description: `Details for ${title.toLowerCase()} only.`,
    evidence: [{ path: PRICING, startLine: line, endLine: line, snippet, why: "here" }],
    ...over,
  });
}

/** Judge accepting everything except titles containing "twice" (rejected) and "Rounding" (confidence cut to 0.4). */
function judgeByTitle(call: FakeCall) {
  return {
    verdicts: judgedFindings(call).map(({ id, finding }) =>
      finding.title.includes("twice")
        ? verdict(id, { verdict: "reject", reasons: ["taxFor is applied once"], checks: { grounded: true, codeAccurate: false, introducedByPr: true, actionable: true, nonTrivial: true, notDuplicate: true } })
        : verdict(id, { severity: finding.severity, confidence: finding.title.includes("Rounding") ? 0.4 : finding.confidence }),
    ),
  };
}

describe("verification", () => {
  test("R6.8 deterministic stages reject candidates with their stage and reason; the rejected list is complete", async () => {
    const correctness: Candidate[] = [
      callerBug(),
      callerBug({ path: "web/other.ts", title: "Not in this PR" }),
      at(40, L3, { title: "Far from the diff" }),
      at(3, L3, { title: "Uses an invented helper", evidence: [{ path: PRICING, startLine: 3, endLine: 3, snippet: "const discount = applyCoupon(items);", why: "invented" }] }),
      at(3, L3, { title: "Region parameter is unused", evidence: [{ path: PRICING, startLine: 3, endLine: 3, snippet: L3, why: "declared" }, { path: "web/cart/summary.ts", startLine: 9, endLine: 9, snippet: "applyRegion(items, region)", why: "invented" }] }),
      at(6, "}", { title: "Closing brace style" }),
      at(4, L4, { title: "Reduce may overflow", confidence: 0.3 }),
      at(4, L4, { title: "Prefer early returns in totals", confidence: 0.8 }),
      at(5, L5, { title: "Tax rounding happens per call", confidence: 0.8 }),
      at(5, L5, { title: "Tax is applied twice", confidence: 0.8 }),
      at(4, L4, { title: "Rounding of subtotal loses cents", severity: "medium", confidence: 0.7 }),
    ];
    const llm = engineLlm({
      review: (agent) => ({ findings: agent === "correctness" ? correctness : agent === "api_compat" ? [callerBug({ title: "Callers of computeTotal do not pass region", confidence: 0.85 })] : [] }),
      verify: judgeByTitle,
    });
    const out = await runReview(
      { db: fx.db, llm },
      await engineRequest(fx, {
        learned: [{ category: "correctness", description: "Prefer early returns", signal: "suppress" }],
        existingComments: [{ id: 99, author: "dana", body: "Tax rounding happens on every call here; round once at the end.", path: PRICING, line: 5 }],
      }),
    );

    const byTitle = Object.fromEntries(out.rejected.map((r) => [r.title, [r.stage, r.reason]]));
    expect(byTitle).toEqual({
      "Not in this PR": ["anchor", "the file is not part of this pull request's diff"],
      "Far from the diff": ["anchor", "line 40 is not near any line of the diff"],
      "Uses an invented helper": ["filter", "none of the cited evidence exists in the repository"],
      "Closing brace style": ["filter", "the problem is not in code this pull request changes"],
      "Reduce may overflow": ["filter", "confidence 0.30 is below the minimum (0.5)"],
      "Prefer early returns in totals": ["learned", "the team has rejected comments like this before"],
      "Tax rounding happens per call": ["existing_comment", "already covered by a comment from @dana (#99)"],
      "Callers of computeTotal do not pass region": ["duplicate", 'same issue as "Callers of computeTotal do not pass the new region argument" (correctness); merged'],
      "Tax is applied twice": ["verifier", "taxFor is applied once"],
      "Rounding of subtotal loses cents": ["verifier", "verified confidence 0.40 is below the minimum (0.5)"],
    });
    expect(out.findings.map((f) => f.title)).toEqual(["Callers of computeTotal do not pass the new region argument", "Region parameter is unused"]);
    // Ungrounded evidence is dropped; grounded evidence is kept.
    expect(out.findings[1]!.evidence.map((e) => e.path)).toEqual([PRICING]);
    // Every candidate is accounted for.
    expect(out.findings.length + out.rejected.length).toBe(correctness.length + 1);
    expect(out.findings[0]!.agents).toEqual(["correctness", "api_compat"]);
  });

  test("R6.8 anchors snap to commentable lines within ±3 and multi-line suggestions survive only on valid ranges", async () => {
    // The head adds lines 1-5; line 6 is context, so line 8 snaps to 6 and line 2-4 is a valid range.
    const llm = engineLlm({
      review: (agent) =>
        agent === "correctness"
          ? {
              findings: [
                at(2, L3, { startLine: 2, endLine: 4, title: "Range fix", suggestion: "a\nb\nc" }),
                at(9, L5, { title: "Snapped fix", startLine: 7, endLine: 9, suggestion: "x\ny\nz", evidence: [{ path: PRICING, startLine: 5, endLine: 5, snippet: L5, why: "x" }] }),
              ],
            }
          : { findings: [] },
    });
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx));
    expect(out.findings.map((f) => [f.title, f.startLine, f.endLine, f.suggestion])).toEqual([
      ["Range fix", 2, 4, "a\nb\nc"],
      ["Snapped fix", 6, 6, null],
    ]);
  });

  test("R6.8 the judge sees diff hunks and evidence code in batches of at most six and returns six checks", async () => {
    const many = Array.from({ length: 8 }, (_, i) => at(1 + (i % 5), [`import { taxFor } from "./tax";`, "", L3, L4, L5][i % 5] || L3, { title: `Distinct problem number ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"][i]}`, startLine: i % 5 === 1 ? 3 : 1 + (i % 5), endLine: i % 5 === 1 ? 3 : 1 + (i % 5) }));
    const llm = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? many : [] }) });
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx));
    const judges = llm.calls.filter((c) => agentOf(c) === "verifier");
    expect(judges.every((c) => judgedFindings(c).length <= 6)).toBe(true);
    const judged = judges.reduce((n, c) => n + judgedFindings(c).length, 0);
    expect(judged).toBe(out.findings.length + out.rejected.filter((r) => r.stage === "verifier").length);
    expect(judges[0]!.req).toMatchObject({ task: "verify", cache: true, schemaName: "finding_verdicts" });
    expect(judges[0]!.req.prompt).toMatch(/<diff nonce="[0-9a-f]+" id="c1" path="services\/billing\/pricing.ts">/);
    expect(judges[0]!.req.prompt).toMatch(/<evidence nonce="[0-9a-f]+" id="c1" path="services\/billing\/pricing.ts" lines="\d+-\d+">/);
    for (const f of out.findings) expect(Object.keys(f.verification.checks).sort()).toEqual(["actionable", "codeAccurate", "grounded", "introducedByPr", "nonTrivial", "notDuplicate"]);
  });

  test("R6.8 judge rejections, failed checks, and judge errors keep candidates out; thresholds apply to verified values", async () => {
    const llm = engineLlm({
      review: (agent) => ({ findings: agent === "correctness" ? [callerBug(), at(5, L5, { title: "Subtotal tax mismatch", severity: "medium" })] : [] }),
      verify: (call) => ({
        verdicts: judgedFindings(call).map(({ id, finding }) =>
          finding.title.startsWith("Callers")
            ? verdict(id, { severity: "low" })
            : verdict(id, { checks: { grounded: true, codeAccurate: true, introducedByPr: true, actionable: true, nonTrivial: false, notDuplicate: true } }),
        ),
      }),
    });
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx, { settings: { ...SETTINGS, minSeverity: "medium" } }));
    expect(out.findings).toEqual([]);
    expect(out.rejected.map((r) => [r.title, r.stage, r.reason])).toEqual([
      ["Callers of computeTotal do not pass the new region argument", "filter", "verified severity low is below the minimum (medium)"],
      ["Subtotal tax mismatch", "verifier", "verified; failed checks: nonTrivial"],
    ]);

    const failing = engineLlm({
      review: (agent) => ({ findings: agent === "correctness" ? [callerBug()] : [] }),
      verify: () => {
        throw new Error("judge overloaded");
      },
    });
    const failed = await runReview({ db: fx.db, llm: failing }, await engineRequest(fx));
    expect(failed.findings).toEqual([]);
    expect(failed.rejected[0]).toMatchObject({ stage: "verifier", reason: "verification failed: judge overloaded" });
    expect(failed.agentRuns.find((r) => r.agent === "verifier")).toMatchObject({ status: "error", candidates: 1, accepted: 0 });
  });

  test("R6.8 ranks by severity × confidence × agreement with rule and learned boosts, and caps at maxComments", async () => {
    expect(rankScore({ severity: "high", confidence: 0.5, agents: ["correctness"], rule: null })).toBe(2);
    expect(rankScore({ severity: "medium", confidence: 0.9, agents: ["correctness", "security"], rule: null })).toBeCloseTo(2.7);
    expect(rankScore({ severity: "medium", confidence: 0.8, agents: ["rules"], rule: { id: "r" }, boosted: true })).toBeCloseTo(3);

    const llm = engineLlm({
      review: (agent) => ({
        findings:
          agent === "correctness"
            ? [
                at(4, L4, { title: "Medium but certain", severity: "medium", confidence: 0.95 }),
                at(5, L5, { title: "High but unsure", severity: "high", confidence: 0.55 }),
                at(1, `import { taxFor } from "./tax";`, { title: "Import violates layering rule", severity: "medium", confidence: 0.9, ruleId: "rule:7" }),
                at(3, L3, { title: "Valued kind of comment about regions", severity: "low", confidence: 0.9 }),
              ]
            : [],
      }),
    });
    const req = await engineRequest(fx, {
      rules: [{ id: "rule:7", text: "Billing must not import tax helpers directly.", paths: ["services/billing/**"], scope: "repo" }],
      learned: [{ category: "correctness", description: "Valued kind of comment about regions", signal: "boost" }],
    });
    const out = await runReview({ db: fx.db, llm }, req);
    // Scores: rule 2 × 0.9 × 1.25 = 2.25; 4 × 0.55 = 2.2; 2 × 0.95 = 1.9; learned boost 1 × 0.9 × 1.5 = 1.35.
    expect(out.findings.map((f) => f.title)).toEqual(["Import violates layering rule", "High but unsure", "Medium but certain", "Valued kind of comment about regions"]);
    expect(out.findings[0]!.rule).toEqual({ id: "rule:7", text: "Billing must not import tax helpers directly." });

    const capped = await runReview({ db: fx.db, llm }, { ...req, settings: { ...SETTINGS, maxComments: 2 } });
    expect(capped.findings.map((f) => f.title)).toEqual(["Import violates layering rule", "High but unsure"]);
    expect(capped.rejected.map((r) => [r.title, r.stage, r.reason])).toEqual([
      ["Medium but certain", "cap", "over the limit of 2 comments"],
      ["Valued kind of comment about regions", "cap", "over the limit of 2 comments"],
    ]);
  });

  test("R6.8 team-rules findings must cite a rule that applies", async () => {
    const llm = engineLlm({
      review: (agent) => ({
        findings:
          agent === "rules"
            ? [at(4, L4, { title: "Uncited convention nit", ruleId: null }), at(5, L5, { title: "Cites a rule for other paths", ruleId: "rule:9" }), at(4, L4, { title: "Cites a worker-only rule", ruleId: "rule:10" }), at(3, L3, { title: "Money must be cents", ruleId: "[rule:8]" })]
            : [],
      }),
    });
    const out = await runReview(
      { db: fx.db, llm },
      await engineRequest(fx, {
        rules: [
          { id: "rule:8", text: "Money values are integer cents.", paths: [], scope: "org" },
          { id: "rule:9", text: "Workers are idempotent.", paths: ["services/billing/**", "workers/**"], scope: "org" },
          { id: "rule:10", text: "Workers log job ids.", paths: ["workers/**"], scope: "org" },
        ],
      }),
    );
    expect(out.findings.map((f) => [f.title, f.rule?.id])).toEqual([
      ["Money must be cents", "rule:8"],
      ["Cites a rule for other paths", "rule:9"],
    ]);
    const reason = "a team-rules finding must cite a rule or instructions file that applies to this file";
    expect(out.rejected).toEqual([
      expect.objectContaining({ title: "Uncited convention nit", stage: "filter", reason }),
      expect.objectContaining({ title: "Cites a worker-only rule", stage: "filter", reason }),
    ]);
  });
});
