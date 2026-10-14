import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { applyRepoConfig, cascadeSummary, fileSettings, loadRepoConfig, pullRequestSettings } from "../src/repo-config";
import { reviewChange } from "../src/engine/review";
import type { Candidate, ModelProvider, ModelRequest, ReviewInput } from "../src/engine/types";

const json = (value: unknown) => JSON.stringify(value);
// A fake source with one tree per revision.
const source = (trees: Record<string, Record<string, string>>) => ({
  tree: async (_r: string, sha: string) => Object.entries(trees[sha] ?? {}).map(([path, content]) => ({ path, sha: sha + ":" + path, size: content.length })),
  blob: async (_r: string, path: string, sha: string) => ({ content: trees[sha.split(":")[0]][path] }),
});
const base = {
  ".openreview/config.json": json({ settings: { mode: "standard", categories: ["correctness", "security"] } }),
  ".openreview/files.json": json({ ignore: ["**/*.generated.ts"] }),
  "services/.openreview/config.json": json({ settings: { strictness: 2, mode: "deep", instructions: "Services own their retries." } }),
  "services/.openreview/files.json": json({ include: ["keep.generated.ts"] }),
  "services/payments/.openreview/config.json": json({ settings: { categories: ["security"], mode: "fast" }, rules: [{ id: "money", instructions: "Amounts stay in cents.", severity: "high", category: "rules", globs: [], enabled: true }] }),
  "services/payments/.openreview/rules.md": "## Idempotency\nseverity: high\nCharges send an idempotency key.",
  "web/.openreview/config.json": "{ not json",
  "docs/.openreview/files.json": json({ ignore: ["**"], unknownKey: true }),
};

test("nested .openreview folders cascade by directory: deeper overrides shallower field by field", async () => {
  const loaded = await loadRepoConfig(source({ base }), "o/r", "base");
  assert.deepEqual(cascadeSummary(loaded.levels).map((l) => [l.directory, l.keys, l.ignore, l.include]), [["(root)", [], 1, 0], ["services", ["mode", "strictness"], 0, 1], ["services/payments", ["mode", "categories"], 0, 0]]);
  const payments = fileSettings(loaded.levels!, "services/payments/charge.ts");
  assert.deepEqual(payments.settings, { strictness: 2, categories: ["security"] });
  assert.deepEqual(payments.sources, { strictness: "services", categories: "services/payments" });
  assert.deepEqual(fileSettings(loaded.levels!, "services/orders.ts").settings, { strictness: 2 });
  assert.deepEqual(fileSettings(loaded.levels!, "web/app.ts").settings, {});
  // Rules from nested folders are scoped to their directory; nested instructions stay scoped text.
  assert.deepEqual(loaded.rules.filter((r) => r.id.startsWith("services/payments")).map((r) => [r.id, r.globs]), [["services/payments:money", ["services/payments/**"]], ["services/payments:idempotency", ["services/payments/**"]]]);
  assert.deepEqual(loaded.directories, [{ directory: "services", instructions: "Services own their retries." }]);
  // Invalid nested files produce warnings; the rest of the cascade still applies.
  assert.ok(loaded.warnings.some((w) => w.startsWith("web/.openreview/config.json is not valid JSON")));
  assert.ok(loaded.warnings.some((w) => w.startsWith("docs/.openreview/files.json is invalid")));
  assert.equal(fileSettings(loaded.levels!, "docs/guide.ts").ignored, false, "the invalid docs ignore-all was not applied");
});

test("ignore and include globs resolve per file, deeper include re-admits a file", async () => {
  const loaded = await loadRepoConfig(source({ base }), "o/r", "base");
  assert.deepEqual(fileSettings(loaded.levels!, "web/api.generated.ts"), { settings: {}, sources: {}, ignored: true, ignoredBy: ".openreview/files.json" });
  assert.equal(fileSettings(loaded.levels!, "services/x.generated.ts").ignored, true);
  assert.equal(fileSettings(loaded.levels!, "services/keep.generated.ts").ignored, false);
  assert.equal(fileSettings(loaded.levels!, "services/payments/api.ts").ignored, false);
  // A locked ignoredPaths setting means folders cannot add ignores.
  assert.equal(fileSettings(loaded.levels!, "web/api.generated.ts", ["ignoredPaths"]).ignored, false);
});

test("PR-wide values take the highest tier and comment limit among touched directories; locks win", async () => {
  const loaded = await loadRepoConfig(source({ base }), "o/r", "base");
  const dashboard = { mode: "standard", maxComments: 10, categories: ["correctness"], instructions: "", lockedKeys: [] as string[] };
  // services is deep; payments says fast but cannot lower what a shallower touched folder raised.
  assert.deepEqual(pullRequestSettings(loaded.levels!, ["services/payments/charge.ts"]).settings, { mode: "deep" });
  assert.equal(applyRepoConfig(dashboard, loaded, ["services/payments/charge.ts"]).settings.mode, "deep");
  assert.equal(applyRepoConfig(dashboard, loaded, ["web/app.ts"]).settings.mode, "standard", "untouched folders do not apply");
  assert.equal(applyRepoConfig({ ...dashboard, mode: "deep" }, { ...loaded, settings: {} }, ["services/payments/a.ts"]).settings.mode, "deep");
  assert.equal(applyRepoConfig({ ...dashboard, mode: "fast" }, { ...loaded, settings: {} }, ["services/payments/a.ts"]).settings.mode, "deep", "folders only raise the tier");
  const locked = applyRepoConfig({ ...dashboard, lockedKeys: ["mode", "categories"] }, loaded, ["services/payments/charge.ts"]);
  assert.equal(locked.settings.mode, "standard");
  assert.deepEqual(locked.blocked.sort(), ["categories", "mode"]);
  assert.deepEqual(fileSettings(loaded.levels!, "services/payments/charge.ts", ["categories"]).settings, { strictness: 2 });
});

test("only the base revision is read: folders added or edited on the head branch are ignored", async () => {
  const head = { ...base, "services/payments/.openreview/config.json": json({ settings: { categories: ["style"], strictness: 0 } }), "web/.openreview/files.json": json({ ignore: ["**"] }) };
  const fake = source({ base, head });
  const fromBase = await loadRepoConfig(fake, "o/r", "base");
  assert.deepEqual(fileSettings(fromBase.levels!, "services/payments/charge.ts").settings.categories, ["security"]);
  assert.equal(fileSettings(fromBase.levels!, "web/app.ts").ignored, false);
  const fromHead = await loadRepoConfig(fake, "o/r", "head");
  assert.equal(fileSettings(fromHead.levels!, "web/app.ts").ignored, true, "the head tree would differ; reviews never load it");
});

test("reviews apply each finding's directory categories and thresholds and skip ignored files", async () => {
  const content = "export function charge(c) {\n  return c / 100;\n}";
  const input: ReviewInput = {
    repository: "o/r", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "t", description: "", rules: [], mode: "standard",
    files: [{ path: "services/payments/charge.ts", sha: "1", content }, { path: "web/total.ts", sha: "2", content }, { path: "web/api.generated.ts", sha: "3", content }],
    diff: ["services/payments/charge.ts", "web/total.ts", "web/api.generated.ts"].map((path) => ({ path, status: "modified", patch: "@@ -1,3 +1,3 @@\n export function charge(c) {\n-  return c;\n+  return c / 100;\n }" })),
    fileSettings: (path) => path.startsWith("services/payments/") ? { categories: ["security"], minimumConfidence: 0.9, severityThreshold: "high" } : path === "web/api.generated.ts" ? { ignored: true, ignoredBy: ".openreview/files.json" } : undefined,
  };
  const candidate = (filePath: string, title: string, extra: Partial<Candidate> = {}): Candidate => ({ title, description: "charge() divides cents by 100 before storing them.", severity: "high", confidence: 0.95, category: "correctness", filePath, startLine: 2, endLine: 2, evidence: [{ filePath, startLine: 2, quote: "  return c / 100;" }], impact: "Amounts shrink.", suggestedFix: "Keep cents.", symbol: "charge", ...extra });
  const model: ModelProvider = { async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    const value = request.task === "review:correctness" ? { findings: [candidate("services/payments/charge.ts", "Payments correctness issue"), candidate("web/total.ts", "Web totals shrink"), candidate("web/api.generated.ts", "Generated code issue")] }
      : request.task === "review:security" ? { findings: [candidate("services/payments/charge.ts", "Payments security issue", { category: "security", severity: "medium" }), candidate("services/payments/charge.ts", "Payments token exposure", { category: "security", confidence: 0.88, description: "The charge helper logs the token.", impact: "Tokens leak." })] }
      : request.task.startsWith("review:") ? { findings: [] }
      : request.task === "verify" ? { decisions: (request.input as { candidates: unknown[] }).candidates.map((_, index) => ({ index, publish: true, reason: "The divided amount is stored as cents.", confidence: 0.95 })) }
      : request.task === "diagram" ? { diagram: null } : request.task === "exploit" ? { assessments: (request.input as { findings: unknown[] }).findings.map((_, index) => ({ index, exploitPath: true, reason: "Reachable from the charge endpoint." })) }
      : { reviewScore: { value: 2, reason: "Amounts shrink by a factor of one hundred." }, summary: "Totals are now divided before storage." };
    return { value: schema.parse(value), usage: { task: request.task, provider: "f", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  } };
  const result = await reviewChange({ ...input, settings: { categories: ["correctness", "security"], minimumConfidence: 0.85, severityThreshold: "medium", securityScan: false } }, model);
  assert.deepEqual(result.findings.map((f) => f.title).sort(), ["Web totals shrink"]);
  const reasons = Object.fromEntries((result.metadata.suppressions ?? []).map((s) => [s.title, s.reason]));
  assert.equal(reasons["Payments correctness issue"], "Category disabled for this file's directory");
  assert.equal(reasons["Payments security issue"], "Below this directory's severity threshold");
  assert.equal(reasons["Payments token exposure"], "Below this directory's confidence threshold");
  assert.ok(!("Generated code issue" in reasons) || /does not match source/.test(reasons["Generated code issue"]));
  assert.ok(result.metadata.skippedFiles?.some((f) => f.path === "web/api.generated.ts" && f.reason === "Excluded by .openreview/files.json"));
});
