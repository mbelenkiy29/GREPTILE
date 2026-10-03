import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { creditsFor, MODE_PROFILES, runReview, type ReviewMode } from "@/lib/engine";
import { createGateway } from "@/lib/llm";
import { agentOf, callerBug, engineLlm, engineRequest, type Fixture } from "./helpers/engine";
import { reviewFixture } from "./helpers/review-fixture";

let fx: Fixture;
beforeAll(async () => {
  // Enough signals that every specialized agent has a reason to run: auth, a loop with I/O, rules.
  fx = await reviewFixture({
    headExtra: {
      "services/api/handlers.ts": `import { computeTotal } from "../billing/pricing";\n\nexport async function handleCheckout(req: { items: number[]; token: string }) {\n  const prices: number[] = [];\n  for (const id of req.items) {\n    const res = await fetch("/prices/" + id);\n    prices.push(Number(await res.text()));\n  }\n  if (!req.token) throw new Error("unauthenticated");\n  return { total: computeTotal(prices, "eu") };\n}\n`,
    },
  });
});
afterAll(() => fx.fixture.cleanup());

const RULES = [{ id: "rule:1", text: "Money values are integer cents.", paths: [], scope: "org" as const }];

describe("review modes", () => {
  test("R4.1 modes differ in context budget, agent count, and retrieval depth; standard is the default profile", async () => {
    const runs: Record<string, Awaited<ReturnType<typeof runReview>>> = {};
    const agents: Record<string, string[]> = {};
    for (const mode of ["fast", "standard", "deep"] as ReviewMode[]) {
      const llm = engineLlm();
      runs[mode] = await runReview({ db: fx.db, llm, embedder: fx.embedder }, await engineRequest(fx, { mode, rules: RULES }));
      agents[mode] = llm.calls.filter((c) => c.req.task === "review").map(agentOf);
    }
    expect(Object.values(runs).map((r) => r.context.tokenBudget)).toEqual([12_000, 40_000, 100_000]);
    expect(agents.fast).toHaveLength(2);
    expect(agents.fast![0]).toBe("correctness");
    expect(agents.standard).toHaveLength(5);
    expect(agents.deep!.length).toBeGreaterThan(5);
    expect(runs.deep!.classification.skippedAgents.every((s) => !s.reason.includes("mode runs at most"))).toBe(true);
    expect(runs.fast!.classification.skippedAgents.filter((s) => s.reason.startsWith("fast mode runs at most 2 agents"))).not.toHaveLength(0);
    // Deep retrieval walks dependents two levels; fast does not walk dependents at all.
    const dependents = (mode: string) => runs[mode]!.context.items.filter((i) => i.reasons.some((r) => r.startsWith("depends"))).length;
    expect(dependents("fast")).toBe(0);
    expect(dependents("deep")).toBeGreaterThan(0);
    expect(MODE_PROFILES.standard).toMatchObject({ contextTokens: 40_000, maxAgents: 5, dependentDepth: 1 });
    expect(runs.fast!.metadata.mode).toBe("fast");
  });

  test("R4.1 every model call carries the mode so the gateway routes review and verify models per mode", async () => {
    const models: Record<string, Record<string, { model: string; effort?: string }>> = {};
    for (const mode of ["fast", "deep"] as ReviewMode[]) {
      const fake = engineLlm({ review: (agent) => ({ findings: agent === "correctness" ? [callerBug()] : [] }) });
      const gateway = createGateway({ env: { LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant-test-0000000000000000000000000000000" }, provider: fake });
      const out = await runReview({ db: fx.db, llm: gateway }, await engineRequest(fx, { mode }));
      expect(fake.calls.every((c) => c.req.mode === mode || (c.req.mode === "deep" && agentOf(c) === "security"))).toBe(true);
      models[mode] = Object.fromEntries(fake.calls.map((c) => [`${c.req.task}:${agentOf(c)}`, { model: c.req.model!, effort: c.req.effort }]));
      expect(out.metadata.models.correctness).toBe(models[mode]!["review:correctness"]!.model);
      expect(out.usage.costUsd).not.toBeNull();
    }
    expect(models.fast!["review:correctness"]).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(models.deep!["review:correctness"]).toEqual({ model: "claude-opus-5-5", effort: "xhigh" });
    expect(models.fast!["verify:verifier"]).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(models.deep!["verify:verifier"]).toEqual({ model: "claude-opus-5-5", effort: "high" });
    expect(models.deep!["classify:classifier"]!.model).toBe("claude-haiku-4-5");
    expect(models.fast!["classify:classifier"]).toBeUndefined();

    // Operators can pin per-mode models.
    const fake = engineLlm();
    const pinned = createGateway({ env: { LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant-test-0000000000000000000000000000000", LLM_MODEL_FAST: "my-fast-model" }, provider: fake });
    const out = await runReview({ db: fx.db, llm: pinned }, await engineRequest(fx, { mode: "fast" }));
    expect(out.metadata.models.correctness).toBe("my-fast-model");
    expect(out.usage.costUsd).toBeNull(); // no price for the pinned model: cost is unknown, not zero
  });

  test("R4.1 each mode consumes a configurable number of credits", () => {
    expect([creditsFor("fast", {}), creditsFor("standard", {}), creditsFor("deep", {})]).toEqual([1, 2, 4]);
    expect(creditsFor("deep", { CREDITS_DEEP: "6" })).toBe(6);
    expect(creditsFor("fast", { CREDITS_FAST: "0.5" })).toBe(0.5);
    expect(() => creditsFor("standard", { CREDITS_STANDARD: "-1" })).toThrow();
  });
});
