import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticChunks } from "../src/engine/chunks";
import { hybridRank } from "../src/engine/hybrid";

test("semantic chunks split at definitions, keep the preamble, window oversized spans and cover every line", () => {
  const content = ["import x from 'y';", "", "export function total(c) {", "  return c;", "}", "export class Ledger {", ...Array.from({ length: 120 }, (_, i) => `  line${i} = ${"z".repeat(30)};`), "}"].join("\n");
  const chunks = semanticChunks(content, [{ line: 3, name: "total" }, { line: 6, name: "Ledger" }], 1000);
  assert.deepEqual(chunks.slice(0, 2).map((c) => [c.startLine, c.endLine, c.symbol]), [[1, 2, undefined], [3, 5, "total"]]);
  const ledger = chunks.filter((c) => c.symbol === "Ledger");
  assert.ok(ledger.length > 1, "oversized definitions are windowed");
  assert.ok(chunks.every((c) => c.content.length <= 1000));
  const covered = new Set(chunks.flatMap((c) => Array.from({ length: c.endLine - c.startLine + 1 }, (_, i) => c.startLine + i)));
  assert.equal(covered.size, content.split("\n").length);
  assert.deepEqual(semanticChunks("a\nb", []).map((c) => [c.startLine, c.endLine]), [[1, 2]]);
  assert.deepEqual(semanticChunks("", []), []);
});

// Fake 4-dimension embeddings: cosine similarity against the query stands in for vector search scores.
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
test("hybrid ranking combines vector, full-text and graph signals with per-source normalization", () => {
  const query = [1, 0, 0.5, 0];
  const chunks = [
    { path: "src/billing.ts", startLine: 10, endLine: 30, vector: [0.9, 0.1, 0.5, 0] },
    { path: "src/billing.ts", startLine: 31, endLine: 60, vector: [0.2, 0.9, 0, 0.1] },
    { path: "src/payments.ts", startLine: 1, endLine: 20, vector: [0.7, 0, 0.6, 0.2] },
    { path: "docs/readme.md", startLine: 1, endLine: 5, vector: [0, 0, 0, 1] },
  ];
  const vector = chunks.map((c) => ({ path: c.path, startLine: c.startLine, endLine: c.endLine, score: cosine(query, c.vector) }));
  const ranked = hybridRank({ vector, text: [{ path: "src/payments.ts", score: 1 }, { path: "src/util.ts", score: 0.5 }], graph: [{ path: "src/payments.ts", score: 0.8 }, { path: "src/billing.ts", score: 0.4 }] });
  assert.equal(ranked[0].path, "src/payments.ts", "strong in all three signals");
  assert.equal(ranked[0].reason, "semantic + full-text + graph match");
  const billing = ranked.find((r) => r.path === "src/billing.ts")!;
  assert.deepEqual([billing.startLine, billing.endLine], [10, 30], "best-matching chunk lines are kept");
  assert.ok(!ranked.some((r) => r.path === "docs/readme.md"), "zero-similarity chunks contribute nothing");
  assert.deepEqual(ranked.map((r) => r.path), ["src/payments.ts", "src/billing.ts", "src/util.ts"]);
  assert.ok(ranked.every((r, i) => i === 0 || ranked[i - 1].score >= r.score));
  assert.ok(ranked[0].score <= 1);
});

test("hybrid ranking works with embeddings disabled and ignores empty or invalid scores", () => {
  const ranked = hybridRank({ vector: [], text: [{ path: "a.ts", score: 2 }, { path: "b.ts", score: 1 }], graph: [{ path: "b.ts", score: 1 }, { path: "c.ts", score: Number.NaN }] });
  assert.deepEqual(ranked.map((r) => r.path), ["b.ts", "a.ts"]);
  assert.equal(ranked[1].reason, "full-text match");
  assert.deepEqual(hybridRank({}), []);
});
