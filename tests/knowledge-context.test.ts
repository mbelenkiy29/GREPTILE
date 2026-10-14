import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { knowledgeNote, knowledgeTokenBudgets, selectKnowledge, type KnowledgeEntry } from "../src/knowledge-context";
import { reviewChange } from "../src/engine/review";
import type { Candidate, ModelProvider, ModelRequest, ReviewInput } from "../src/engine/types";

const entry = (subsystem: string, files: string[], updatedAt = 1, extra: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({ subsystem, description: `${subsystem} handles its part of checkout.`, files, dependencies: [], risks: ["Currency units must stay in cents."], conventions: ["Amounts are integers."], updatedAt, ...extra });
const head = new Set(["src/cart/total.ts", "src/cart/discount.ts", "src/payments/charge.ts", "src/auth/session.ts", "README.md"]);

test("knowledge entries are selected by how directly they cover the changed files, newest first on ties", () => {
  const entries = [
    entry("Sessions", ["src/auth/session.ts"]),
    entry("Discounts", ["src/cart/discount.ts"], 5),
    entry("Cart totals", ["src/cart/total.ts", "src/cart/discount.ts"]),
    entry("Payments", ["src/payments/charge.ts"]),
    entry("Pricing", ["src/cart/discount.ts"], 9),
  ];
  const { selected, stale } = selectKnowledge(entries, ["src/cart/total.ts"], head, knowledgeTokenBudgets.standard);
  // Direct coverage (10 per changed file) beats same-directory coverage (3); unrelated entries are left out.
  assert.deepEqual(selected.map((s) => s.subsystem), ["Cart totals", "Pricing", "Discounts"]);
  assert.equal(stale, 0);
  assert.deepEqual(selectKnowledge(entries, ["docs/notes.md"], head, 1500).selected, []);
});

test("entries are bounded by the token budget and clipped; stale entries about deleted files are skipped", () => {
  const long = (i: number) => entry("Area " + i, ["src/cart/total.ts"], i, { description: "x".repeat(5000), risks: Array.from({ length: 9 }, () => "r".repeat(500)) });
  const many = Array.from({ length: 30 }, (_, i) => long(i));
  const { selected, tokens } = selectKnowledge(many, ["src/cart/total.ts"], head, knowledgeTokenBudgets.fast);
  assert.ok(tokens <= knowledgeTokenBudgets.fast, String(tokens));
  assert.ok(selected.length > 0 && selected.length < 30);
  assert.ok(selected.every((s) => s.description.length <= 600 && s.risks.length <= 5 && s.risks.every((r) => r.length <= 200)));
  assert.equal(selected[0].subsystem, "Area 29", "newest first among equally relevant entries");
  const stale = selectKnowledge([entry("Removed module", ["src/legacy/old.ts"]), entry("Half removed", ["src/legacy/old.ts", "src/cart/total.ts"])], ["src/cart/total.ts", "src/legacy/old.ts"], head, 1500);
  assert.equal(stale.stale, 1);
  assert.deepEqual(stale.selected.map((s) => [s.subsystem, s.files]), [["Half removed", ["src/cart/total.ts"]]]);
});

test("reviews receive knowledge as labelled background, never as evidence, and list the entries in Coverage", async () => {
  const total = "export function total(items) {\n  return items.reduce((s, i) => s + i.cents, 0);\n}";
  const input: ReviewInput = {
    repository: "acme/shop", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "Totals", description: "", rules: [], mode: "standard",
    files: [{ path: "src/cart/total.ts", sha: "1", content: total }],
    diff: [{ path: "src/cart/total.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function total(items) {\n-  return items.reduce((s, i) => s + i.price, 0);\n+  return items.reduce((s, i) => s + i.cents, 0);\n }" }],
    knowledge: selectKnowledge([entry("Cart totals", ["src/cart/total.ts"])], ["src/cart/total.ts"], head, 1500).selected,
  };
  // Candidates citing only knowledge text: once with a real file path, once with a made-up knowledge path.
  const fromKnowledge: Candidate = { title: "Totals break the cents convention", description: "The knowledge base says amounts must stay in cents.", severity: "high", confidence: 0.95, category: "correctness", filePath: "src/cart/total.ts", startLine: 2, endLine: 2, evidence: [{ filePath: "src/cart/total.ts", startLine: 2, quote: "Currency units must stay in cents." }], impact: "Wrong totals.", suggestedFix: "Keep cents.", symbol: "total" };
  const knowledgePath: Candidate = { ...fromKnowledge, title: "Knowledge base contradiction", evidence: [{ filePath: "knowledge/Cart totals", startLine: 1, quote: "Cart totals handles its part of checkout." }] };
  const requests: ModelRequest[] = [];
  const model: ModelProvider = {
    async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
      requests.push(request);
      const value = request.task === "review:correctness" ? { findings: [fromKnowledge, knowledgePath] } : request.task.startsWith("review:") ? { findings: [] } : request.task === "diagram" ? { diagram: null } : { reviewScore: { value: 5, reason: "No verified defects were found in the reviewed change." }, summary: "Cart totals are now summed in cents." };
      return { value: schema.parse(value), usage: { task: request.task, provider: "f", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
    },
  };
  const result = await reviewChange(input, model);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.metadata.suppressions?.map((s) => s.reason), ["Evidence or changed-line location does not match source", "Evidence or changed-line location does not match source"]);
  const shared = requests.find((r) => r.task === "review:correctness")!.context as { knowledgeBase: { note: string; entries: { subsystem: string }[] } };
  assert.equal(shared.knowledgeBase.note, knowledgeNote);
  assert.deepEqual(shared.knowledgeBase.entries.map((e) => e.subsystem), ["Cart totals"]);
  assert.match(result.summary, /### Coverage\n[\s\S]*Knowledge base entries supplied as background \(not evidence\): `Cart totals`\./);
  assert.deepEqual(result.metadata.knowledge, ["Cart totals"]);
  // Without relevant entries nothing is added.
  const plain = await reviewChange({ ...input, knowledge: [] }, model);
  assert.doesNotMatch(plain.summary, /Knowledge base entries/);
});
