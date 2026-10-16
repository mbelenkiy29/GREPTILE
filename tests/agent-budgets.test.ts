import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { agentBudgets, agentHardCaps, configuredBudget, memoryToolbox } from "../src/engine/agent";
import { scopeDefaults, validTriggerSettings } from "../src/review-settings";
import { reviewChange } from "../src/engine/review";
import type { ModelProvider, ModelRequest, ReviewInput, ToolRequest, ToolTurn } from "../src/engine/types";

test("configured budgets clamp to the operator's hard caps; 0 keeps the tier default", () => {
  const caps = { turns: 60, toolCalls: 150 };
  assert.deepEqual(configuredBudget(agentBudgets.standard, 500, 900, caps), { ...agentBudgets.standard, turns: 60, toolCalls: 150 });
  assert.deepEqual(configuredBudget(agentBudgets.standard, 0, undefined, caps), agentBudgets.standard);
  assert.deepEqual(configuredBudget(agentBudgets.standard, 4, 7, caps), { ...agentBudgets.standard, turns: 4, toolCalls: 7 });
  assert.deepEqual(configuredBudget(agentBudgets.standard, -3, Number.NaN, caps), agentBudgets.standard);
  // The tier default itself is capped too (deep defaults exceed a strict operator cap).
  assert.deepEqual(configuredBudget(agentBudgets.deep, 0, 0, { turns: 10, toolCalls: 20 }), { ...agentBudgets.deep, turns: 10, toolCalls: 20 });
  assert.deepEqual(agentHardCaps({}), { turns: 60, toolCalls: 150 });
  assert.deepEqual(agentHardCaps({ AGENT_MAX_TURNS: "12", AGENT_MAX_TOOL_CALLS: "40" }), { turns: 12, toolCalls: 40 });
  assert.deepEqual(agentHardCaps({ AGENT_MAX_TURNS: "zero", AGENT_MAX_TOOL_CALLS: "99999" }), { turns: 60, toolCalls: 1000 });
  assert.ok(validTriggerSettings({ agentTurns: 1000, hypothesisToolCalls: 0 }));
  for (const bad of [{ agentTurns: 1001 }, { agentToolCalls: -1 }, { hypothesisTurns: 1.5 }]) assert.equal(validTriggerSettings(bad), false, JSON.stringify(bad));
});

test("budget settings inherit workspace → team → repository like other review settings", () => {
  const scopes = [{ settings: { agentTurns: 20, agentToolCalls: 50 }, overrideKeys: ["agentTurns", "agentToolCalls"] }, { teamId: "t1", settings: { agentTurns: 30 }, overrideKeys: ["agentTurns"] }];
  assert.deepEqual([scopeDefaults(scopes).agentTurns, scopeDefaults(scopes).agentToolCalls], [20, 50]);
  assert.deepEqual([scopeDefaults(scopes, "t1").agentTurns, scopeDefaults(scopes, "t1").agentToolCalls], [30, 50]);
  assert.equal(scopeDefaults([]).agentTurns, 0);
});

const content = "export function total(c) {\n  return c / 100;\n}";
const input: ReviewInput = { repository: "o/r", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "t", description: "", rules: [], mode: "standard", files: [{ path: "total.ts", sha: "1", content }], diff: [{ path: "total.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function total(c) {\n-  return c;\n+  return c / 100;\n }" }] };
// A model that never stops investigating: every turn reads a file again.
class Endless implements ModelProvider {
  turns: Record<string, number> = {};
  async runTools(request: ToolRequest): Promise<ToolTurn> {
    this.turns[request.task] = (this.turns[request.task] ?? 0) + 1;
    const toolCalls = [{ id: "c" + this.turns[request.task], name: "read_file", input: { path: "total.ts" } }];
    return { content: "", toolCalls, stopReason: "tool_use", message: { role: "assistant", content: "", toolCalls }, usage: { task: request.task, provider: "f", model: "f", inputTokens: 10, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  }
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    const value = request.task === "plan" ? { hypotheses: [1, 2].map((i) => ({ claim: `Hypothesis ${i}: callers expect dollars from total()`, category: "correctness", filePath: "total.ts", startLine: 2, check: "Read the callers of total()" })) } : request.task === "diagram" ? { diagram: null } : { reviewScore: { value: 4, reason: "No verified defects were found in the reviewed change." }, summary: "Totals are divided by one hundred now." };
    return { value: schema.parse(value), usage: { task: request.task, provider: "f", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  }
}

test("the configured budget reaches the agentic engine and is recorded; the hard cap still wins", async () => {
  const model = new Endless();
  const result = await reviewChange(input, model, async () => {}, undefined, { engine: "agentic", tools: memoryToolbox(input.files, input.headSha), budgets: { agentTurns: 3, agentToolCalls: 2 } });
  assert.equal(result.metadata.agentRun?.turns, 3);
  assert.equal(result.metadata.agentRun?.toolCalls, 2);
  assert.equal(result.metadata.agentRun?.stopReason, "turn budget exhausted");
  assert.deepEqual(result.metadata.agentBudget, { turns: 3, toolCalls: 2 });
  const previous = process.env.AGENT_MAX_TURNS;
  process.env.AGENT_MAX_TURNS = "2";
  try {
    const capped = await reviewChange(input, new Endless(), async () => {}, undefined, { engine: "agentic", tools: memoryToolbox(input.files, input.headSha), budgets: { agentTurns: 50 } });
    assert.equal(capped.metadata.agentRun?.turns, 2);
    assert.deepEqual(capped.metadata.agentBudget, { turns: 2, toolCalls: agentBudgets.standard.toolCalls });
  } finally { if (previous === undefined) delete process.env.AGENT_MAX_TURNS; else process.env.AGENT_MAX_TURNS = previous; }
});

test("hypothesis investigations use the per-hypothesis budget", async () => {
  const model = new Endless();
  const result = await reviewChange(input, model, async () => {}, undefined, { engine: "hypotheses", tools: memoryToolbox(input.files, input.headSha), budgets: { hypothesisTurns: 2, hypothesisToolCalls: 1 } });
  assert.deepEqual(result.metadata.hypotheses?.map((h) => [h.turns, h.toolCalls, h.stopReason]), [[2, 1, "turn budget exhausted"], [2, 1, "turn budget exhausted"]]);
  assert.deepEqual(result.metadata.agentBudget, { turns: 2, toolCalls: 1, perHypothesis: true });
  assert.deepEqual(model.turns, { "hypothesis:1": 2, "hypothesis:2": 2 });
});
