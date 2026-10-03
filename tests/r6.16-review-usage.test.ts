import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { reviews, usageEvents } from "@/lib/db/schema";
import { createGateway, LlmAbortError } from "@/lib/llm";
import { FakeLlm } from "@/lib/llm/fake";
import { modelCallTotals, PostgresModelCallRecorder } from "@/lib/llm/recorder";
import { creditsFor } from "@/lib/pipeline/engine";
import { cancelReview, requestReview } from "@/lib/pipeline/request";
import { runReviewJob } from "@/lib/review/run";
import { pipelineFixture } from "./helpers/pipeline";
import { engineFinding, reviewOutput, stubEngine } from "./helpers/stub-engine";

type Fixture = Awaited<ReturnType<typeof pipelineFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

/** A gateway over a fake model priced at $1 per million input and $2 per million output tokens. */
function pricedGateway(f: Fixture, onCall: () => void = () => undefined) {
  const fake = new FakeLlm(() => {
    onCall();
    return "ok";
  });
  const gateway = createGateway({
    env: { LLM_PROVIDER: "fake", LLM_PRICING_JSON: JSON.stringify({ "fake-model": { input: 1, output: 2 } }) },
    provider: fake,
    recorder: new PostgresModelCallRecorder(f.db),
  });
  return { fake, gateway };
}

describe("review cost and cancellation", () => {
  test("R6.16 records tokens, estimated cost, and credits per run in usage_events and on the review", async () => {
    fx = await pipelineFixture();
    const { gateway } = pricedGateway(fx);
    // The engine's model calls carry the run id, so the gateway's accounting attributes them to this run.
    const engine = stubEngine(() => reviewOutput({ findings: [engineFinding()] }), {
      reviewing: async (req, deps) => {
        await deps.llm.text({ system: "s", prompt: "review this", task: "review", meta: { orgId: req.orgId, ...req.meta }, signal: req.signal });
      },
    });
    const res = await fx.review(engine.run, {}, { llm: gateway });
    expect(res.status).toBe("completed");

    // Tokens and cost come from the same source: the gateway's records for the run (not the engine's own report).
    const totals = await modelCallTotals(fx.db, "org_a", { reviewRunId: res.runId });
    expect(totals.calls).toBe(1);
    const [event] = await fx.db.select().from(usageEvents);
    expect(event).toMatchObject({
      orgId: "org_a",
      repoId: fx.repo.id,
      reviewRunId: res.runId,
      prNumber: 7,
      author: "dana",
      kind: "review",
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      credits: creditsFor("standard"),
    });
    expect(event!.inputTokens).toBeGreaterThan(0);
    expect(event!.costUsd).toBeCloseTo(totals.costUsd, 9);
    expect(event!.costUsd).toBeGreaterThan(0);
    const run = await fx.run(res.runId);
    expect(run).toMatchObject({ credits: creditsFor("standard"), inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costUsd: event!.costUsd });
    const [review] = await fx.db.select().from(reviews);
    expect(review).toMatchObject({ creditsUsed: creditsFor("standard"), costUsd: event!.costUsd, usage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens } });

    // Without gateway records (a bare provider), the engine's own estimate is used; deep mode costs more credits.
    const deep = await fx.review(stubEngine(() => reviewOutput()).run, { mode: "deep" });
    const [, second] = await fx.db.select().from(usageEvents).orderBy(usageEvents.id);
    expect(second).toMatchObject({ reviewRunId: deep.runId, credits: creditsFor("deep"), costUsd: 0.0123, inputTokens: 1200, outputTokens: 300 });
    expect(creditsFor("deep")).toBe(4);
    expect(creditsFor("fast", { CREDITS_FAST: "0", CREDITS_STANDARD: "1", CREDITS_DEEP: "3" })).toBe(0);
    const [after] = await fx.db.select().from(reviews).where(eq(reviews.id, review!.id));
    expect(after!.creditsUsed).toBe(creditsFor("standard") + creditsFor("deep"));
    expect(after!.costUsd).toBeCloseTo(event!.costUsd! + 0.0123, 6);
  });

  test("R6.16 cancellation stops further model calls at the next stage, and the tokens used are still recorded", async () => {
    fx = await pipelineFixture();
    let runId = 0;
    const { fake, gateway } = pricedGateway(fx);
    const call = (prompt: string) => async (req: Parameters<Parameters<typeof stubEngine>[0]>[0], deps: Parameters<Parameters<typeof stubEngine>[0]>[1]) => {
      await deps.llm.text({ system: "s", prompt, task: "review", meta: { orgId: req.orgId, ...req.meta }, signal: req.signal });
    };
    const engine = stubEngine(() => reviewOutput(), {
      reviewing: async (req, deps) => {
        await call("first agent")(req, deps);
        await cancelReview(fx!.db, "org_a", runId, "user_1");
      },
      verifying: call("verifier"),
      summarizing: call("summary"),
    });
    runId = (await requestReview({ db: fx.db, queue: fx.queue }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" })).runId;
    const res = await runReviewJob(fx.deps(engine.run, { llm: gateway }), { runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 });
    expect(res.status).toBe("cancelled");
    expect(fake.calls.map((c) => c.req.prompt)).toEqual(["first agent"]);
    // Tokens and cost come from the same source: the gateway's records for the run (not the engine's own report).
    const totals = await modelCallTotals(fx.db, "org_a", { reviewRunId: res.runId });
    expect(totals.calls).toBe(1);
    const [event] = await fx.db.select().from(usageEvents);
    expect(event).toMatchObject({ reviewRunId: runId, credits: 0 });
    expect(event!.inputTokens).toBeGreaterThan(0);
  });

  test("R6.16 a cancel request aborts an in-flight model call through the request's signal", async () => {
    fx = await pipelineFixture();
    let runId = 0;
    let aborted = false;
    const engine = stubEngine(() => reviewOutput(), {
      reviewing: async (req) => {
        await cancelReview(fx!.db, "org_a", runId, "user_1");
        // A long model call that honors cancellation, as the gateway does.
        await new Promise<void>((resolve) => req.signal!.addEventListener("abort", () => resolve(), { once: true }));
        aborted = true;
        throw new LlmAbortError();
      },
    });
    runId = (await requestReview({ db: fx.db, queue: fx.queue }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" })).runId;
    const res = await runReviewJob(fx.deps(engine.run, { heartbeatMs: 20 }), { runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 });
    expect(aborted).toBe(true);
    expect(res).toMatchObject({ status: "cancelled" });
    expect(fx.host.issueComments.size).toBe(0);
  });
});
