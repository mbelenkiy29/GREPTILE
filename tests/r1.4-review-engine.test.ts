import { afterEach, describe, expect, test } from "vitest";
import { CancelledError, renderFindingMarkdown, renderSummaryMarkdown, runReview, type AgentRunRecord, type EngineStage } from "@/lib/engine";
import { retrieveContext } from "@/lib/retrieval";
import { parsePatch } from "@/lib/review/diff";
import { agentOf, callerBug, engineLlm, engineRequest, PRICING, readAt, type Fixture } from "./helpers/engine";
import { reviewFixture } from "./helpers/review-fixture";

let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

describe("review engine", () => {
  test("R1.4 retrieves callers, callees, and importers beyond the diff through the graph", async () => {
    fx = await reviewFixture();
    const files = await fx.client.listPullRequestFiles("acme/shop", 7);
    const diffs = files.map((f) => parsePatch(f.path, f.status, f.patch));
    const head = new Map([[PRICING, readAt(fx.fixture, fx.head, PRICING)!]]);
    const base = new Map([[PRICING, readAt(fx.fixture, fx.base, PRICING)!]]);
    const bundle = await retrieveContext({ db: fx.db, embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, mode: "standard", diffs, headContent: head, baseContent: base });

    expect(bundle.changed.map((s) => [s.qualifiedName, s.change, s.baseSignature, s.signature])).toEqual([
      ["computeTotal", "modified", "export function computeTotal(items: number[]) {", "export function computeTotal(items: number[], region: string) {"],
    ]);
    const withReason = (re: RegExp) => bundle.items.filter((i) => i.reasons.some((r) => re.test(r))).map((i) => `${i.path}:${i.name ?? ""}`).sort();
    expect(withReason(/^calls changed symbol computeTotal/)).toEqual(["services/api/handlers.ts:handleCheckout", "web/cart/summary.ts:renderSummary"]);
    expect(withReason(/^called by changed symbol computeTotal/)).toEqual(["services/billing/tax.ts:taxFor"]);
    expect(withReason(/^imports changed file services\/billing\/pricing.ts/)).toEqual(["services/api/handlers.ts:handleCheckout", "web/cart/summary.ts:renderSummary"]);
    expect(bundle.items.find((i) => i.name === "handleCheckout")?.content).toContain("computeTotal(req.items)");
    expect(bundle.components).toEqual(["services/api", "services/billing", "web/cart"]);
    // Nothing is retrieved from another tenant's index.
    const other = await retrieveContext({ db: fx.db }, { orgId: "org_b", repoId: fx.repo.id, mode: "standard", diffs, headContent: head });
    expect(other.items.filter((i) => i.kind !== "definition")).toEqual([]);
  });

  test("R1.4 runs specialized agents in parallel on the graph context, then dedupes and ranks their findings", async () => {
    fx = await reviewFixture();
    let inFlight = 0;
    let maxInFlight = 0;
    const llm = engineLlm({
      review: async (agent) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        if (agent === "correctness") return { findings: [callerBug(), callerBug({ startLine: 5, endLine: 5, title: "Tax rounding drifts per call", description: "taxFor rounds each subtotal.", severity: "medium", confidence: 0.7, symbol: null, evidence: [{ path: PRICING, startLine: 5, endLine: 5, snippet: "return subtotal + taxFor(subtotal);", why: "rounded per call" }] })] };
        if (agent === "api_compat") return { findings: [callerBug({ title: "Callers of computeTotal do not pass region", confidence: 0.8 })] };
        return { findings: [] };
      },
    });
    const out = await runReview({ db: fx.db, llm, embedder: fx.embedder }, await engineRequest(fx, { mode: "deep", settings: { ...(await engineRequest(fx)).settings, categories: ["correctness", "api_compat", "testing"] } }));

    // Agents chosen by the classifier ran concurrently on one shared prompt that carries the graph context.
    const reviewCalls = llm.calls.filter((c) => c.req.task === "review");
    expect(reviewCalls.map(agentOf).sort()).toEqual(["api_compat", "correctness", "testing"]);
    expect(maxInFlight).toBe(3);
    for (const c of reviewCalls) {
      expect(c.req.prompt).toMatch(/<repo_code nonce="[0-9a-f]{16}" path="services\/api\/handlers.ts" lines="1-5" kind="caller" name="handleCheckout" reasons="calls changed symbol computeTotal/);
      expect(c.req.prompt).toContain("export function taxFor(amount: number)");
      expect(c.req.prompt).toMatch(/\s3 \+ export function computeTotal\(items: number\[\], region: string\)/);
    }

    // The two reports of the caller bug merged (agreeing agents recorded); ranked above the medium finding.
    expect(out.findings.map((f) => [f.title, f.severity, f.agents])).toEqual([
      ["Callers of computeTotal do not pass the new region argument", "high", ["correctness", "api_compat"]],
      ["Tax rounding drifts per call", "medium", ["correctness"]],
    ]);
    expect(out.rejected).toEqual([expect.objectContaining({ stage: "duplicate", agent: "api_compat" })]);
    expect(out.findings[0]!.evidence.map((e) => `${e.path}:${e.startLine}`)).toEqual([`${PRICING}:3`, "services/api/handlers.ts:4", "web/cart/summary.ts:4"]);
    expect(out.agentRuns.find((r) => r.agent === "correctness")).toMatchObject({ status: "ok", candidates: 2, accepted: 2 });
  });

  test("R1.4 end to end: the cross-file caller bug is retrieved, cited, verified, summarized, and rendered", async () => {
    fx = await reviewFixture();
    const llm = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug()] : [] }) });
    const out = await runReview({ db: fx.db, llm, embedder: fx.embedder }, await engineRequest(fx));

    const callers = out.context.items.filter((i) => i.reasons.some((r) => r.startsWith("calls changed symbol computeTotal"))).map((i) => i.path);
    expect(callers.sort()).toEqual(["services/api/handlers.ts", "web/cart/summary.ts"]);
    const [f] = out.findings;
    expect(f).toMatchObject({ category: "correctness", severity: "high", path: PRICING, startLine: 3, symbol: "computeTotal", priorFindingId: null });
    expect(f!.evidence.map((e) => e.path)).toEqual([PRICING, "services/api/handlers.ts", "web/cart/summary.ts"]);
    expect(f!.verification.verdict).toBe("accept");
    const judge = llm.calls.find((c) => agentOf(c) === "verifier")!;
    expect(judge.req.prompt).toContain("return { total: computeTotal(req.items) };");

    expect(out.summary.confidence).toBe(3); // a high finding caps confidence at 3
    expect(out.summary.diagram).toContain("C1->>C2: handleCheckout → computeTotal");
    const summaryMd = renderSummaryMarkdown(out, { headSha: fx.head });
    expect(summaryMd).toContain("<!-- openreview:summary -->");
    expect(summaryMd).toContain(`| High | \`${PRICING}:3\` | Callers of computeTotal do not pass the new region argument |`);
    const md = renderFindingMarkdown(f!);
    expect(md).toContain("`services/api/handlers.ts:4` — handleCheckout passes one argument");
    expect(md).toContain(`<!-- openreview:fp=${f!.fingerprint} -->`);
  });

  test("R1.4 a failing agent does not abort the review", async () => {
    fx = await reviewFixture();
    const llm = engineLlm({
      review: (agent) => {
        if (agent === "api_compat") throw new Error("upstream timeout");
        return { findings: agent === "correctness" ? [callerBug()] : [] };
      },
    });
    const out = await runReview({ db: fx.db, llm }, await engineRequest(fx));
    expect(out.agentRuns.find((r) => r.agent === "api_compat")).toMatchObject({ status: "error", error: "upstream timeout" });
    expect(out.findings).toHaveLength(1);
  });

  test("R1.4 reports stages and agent runs through hooks, and stops when cancelled", async () => {
    fx = await reviewFixture();
    const stages: EngineStage[] = [];
    const runs: AgentRunRecord[] = [];
    const llm = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug()] : [] }) });
    const out = await runReview(
      { db: fx.db, llm, hooks: { onStage: async (s) => void stages.push(s), onAgentRun: async (r) => void runs.push(r) } },
      await engineRequest(fx, { meta: { reviewRunId: 77 } }),
    );
    expect(stages).toEqual(["ingesting", "retrieving_context", "reviewing", "verifying", "summarizing"]);
    expect(runs.map((r) => r.agent)).toEqual(out.agentRuns.map((r) => r.agent));
    expect(runs.map((r) => r.agent)).toEqual(expect.arrayContaining(["classifier", "correctness", "verifier", "summarizer"]));
    expect(Object.keys(out.metadata.stageTimings).sort()).toEqual(["ingesting", "retrieving_context", "reviewing", "summarizing", "verifying"]);
    expect(out.usage.calls).toBe(llm.calls.length);
    expect(out.usage.inputTokens).toBe(out.agentRuns.reduce((n, r) => n + r.usage.inputTokens, 0));
    expect(out.usage.costUsd).toBeNull(); // the fake model has no price
    expect(llm.calls.every((c) => c.req.meta?.reviewRunId === 77 && c.req.meta?.orgId === "org_a")).toBe(true);

    // A hook that cancels stops the review before any further model call.
    const cancelling = engineLlm();
    await expect(
      runReview({ db: fx.db, llm: cancelling, hooks: { onStage: async (s) => { if (s === "reviewing") throw new CancelledError("superseded"); } } }, await engineRequest(fx)),
    ).rejects.toThrow(CancelledError);
    expect(cancelling.calls.some((c) => c.req.task === "review")).toBe(false);
    // An aborted signal cancels too.
    const controller = new AbortController();
    controller.abort();
    await expect(runReview({ db: fx.db, llm: engineLlm() }, await engineRequest(fx, { signal: controller.signal }))).rejects.toThrow(CancelledError);
  });
});
