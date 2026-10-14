import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { blockingRequirements, groundRequirements, requirementsSection } from "../src/requirements-check";
import { reviewChange } from "../src/engine/review";
import { approvalBlockers } from "../src/approval";
import { approvalDefaults } from "../src/review-settings";
import type { ModelProvider, ModelRequest, ReviewInput, SourceFile } from "../src/engine/types";

const ticketPath = "requirements/linear/conn1/ENG-42.md";
const ticket: SourceFile = { path: ticketPath, sha: "2026-10-01", content: "# ENG-42: Exports\nSource: https://linear.app/acme/issue/ENG-42\n\nAcceptance criteria:\n- Exports include the order total in cents\n- Exports are limited to admins\n- Exports finish within 5 seconds\n- Exports run every Monday", provenance: { repository: "Linear: Acme", revision: "2026-10-01", sourceUrl: "https://linear.app/acme/issue/ENG-42" } };
const exporter = "export function exportOrders(user, orders) {\n  return orders.map((o) => ({ id: o.id, total: o.cents }));\n}";
const input: ReviewInput = {
  repository: "acme/shop", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "Order exports (ENG-42)", description: "Implements ENG-42", rules: [], mode: "standard",
  files: [{ path: "src/export.ts", sha: "1", content: exporter }, ticket],
  diff: [{ path: "src/export.ts", status: "added", patch: "@@ -0,0 +1,3 @@\n+export function exportOrders(user, orders) {\n+  return orders.map((o) => ({ id: o.id, total: o.cents }));\n+}" }],
};
const code = (startLine: number, quote: string) => ({ filePath: "src/export.ts", startLine, quote });
const criteria = [
  { ticket: ticketPath, ticketLine: 5, ticketQuote: "- Exports include the order total in cents", status: "met" as const, reason: "The export maps each order's cents total.", code: [code(2, "  return orders.map((o) => ({ id: o.id, total: o.cents }));")] },
  { ticket: ticketPath, ticketLine: 6, ticketQuote: "- Exports are limited to admins", status: "not met" as const, reason: "exportOrders never checks the user's role.", code: [code(1, "export function exportOrders(user, orders) {")], fix: "Reject non-admin users before exporting." },
  { ticket: ticketPath, ticketLine: 7, ticketQuote: "- Exports finish within 5 seconds", status: "unclear" as const, reason: "Timing cannot be judged from the code.", code: [] },
  { ticket: ticketPath, ticketLine: 8, ticketQuote: "- Exports run every Monday", status: "not met" as const, reason: "No scheduler is added.", code: [] },
  // Grounding rejections: an invented criterion, a wrong line, an unknown ticket, invented code for "met".
  { ticket: ticketPath, ticketLine: 9, ticketQuote: "- Exports must be approved automatically", status: "met" as const, reason: "Invented.", code: [] },
  { ticket: ticketPath, ticketLine: 4, ticketQuote: "- Exports include the order total in cents", status: "met" as const, reason: "Wrong line.", code: [] },
  { ticket: "requirements/linear/conn1/ENG-99.md", ticketLine: 1, ticketQuote: "# ENG-99", status: "met" as const, reason: "Unknown ticket.", code: [] },
];

test("criteria are grounded in the ticket and code: met, not met and unclear; fabrications are dropped or downgraded", () => {
  const { results, candidates, dropped } = groundRequirements({ criteria: [...criteria, { ...criteria[0], ticketLine: 5, status: "met", reason: "The exporter passed its tests in CI.", code: [code(2, "  return orders.map((o) => ({ id: o.id, total: o.dollars }));")] }] }, input.files, input.diff);
  assert.equal(dropped, 4, "invented, wrong-line, unknown-ticket and duplicate criteria are dropped");
  assert.deepEqual(results.map((r) => [r.ticketLine, r.status, r.code.length]), [[5, "met", 1], [6, "not met", 1], [7, "unclear", 0], [8, "not met", 0]]);
  assert.equal(results[0].criterion, "- Exports include the order total in cents", "the criterion is the ticket's own text");
  // A grounded "not met" on a changed line becomes one candidate citing both the code and the ticket.
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].title, candidates[0].filePath, candidates[0].startLine, candidates[0].agent, candidates[0].suggestedFix], ["Requirement not met: - Exports are limited to admins", "src/export.ts", 1, "requirements", "Reject non-admin users before exporting."]);
  assert.deepEqual(candidates[0].evidence.map((e) => e.filePath), ["src/export.ts", ticketPath]);
  assert.equal(blockingRequirements(results), 1, "only grounded not-met criteria block approval");
  // "met" with code that does not match the source becomes unclear; claims of test execution are not published.
  const forged = groundRequirements({ criteria: [{ ...criteria[0], reason: "The exporter passed its tests in CI.", code: [code(2, "return dollars;")] }] }, input.files, input.diff);
  assert.deepEqual(forged.results.map((r) => [r.status, r.reason]), [["unclear", "No reason was recorded."]]);
  const table = requirementsSection(results);
  assert.match(table, /^\| Status \| Criterion \| Evidence \|\n\| --- \| --- \| --- \|\n\| ✅ met \| - Exports include the order total in cents \(\[Linear: Acme\]\(<https:\/\/linear\.app\/acme\/issue\/ENG-42>\)\) \| `src\/export\.ts:2` · The export maps each order's cents total\. \|/);
  assert.match(table, /\| ❌ not met \| - Exports run every Monday[^\n]*\| — · No scheduler is added\. \|/);
  assert.match(table, /\| ❔ unclear \|/);
});

class RequirementsModel implements ModelProvider {
  tasks: string[] = [];
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    this.tasks.push(request.task);
    const value = request.task === "requirements" ? { criteria }
      : request.task.startsWith("review:") ? { findings: [] }
      : request.task === "verify" ? { decisions: (request.input as { candidates: unknown[] }).candidates.map((_, index) => ({ index, publish: true, reason: "exportOrders returns data without checking the user's role.", confidence: 0.92 })) }
      : request.task === "diagram" ? { diagram: null }
      : request.task === "exploit" ? { assessments: [] }
      : { reviewScore: { value: 3, reason: "One linked acceptance criterion is not met by the export." }, summary: "Adds an order export for ENG-42." };
    return { value: schema.parse(value), usage: { task: request.task, provider: "f", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  }
}

test("reviews check linked tickets: the section, a verified not-met finding, a coverage note and the approval block", async () => {
  const model = new RequirementsModel();
  const result = await reviewChange({ ...input, settings: { categories: ["correctness"] } }, model);
  assert.ok(model.tasks.includes("requirements"));
  assert.deepEqual(result.findings.map((f) => [f.title, f.agent]), [["Requirement not met: - Exports are limited to admins", "requirements"]]);
  assert.match(result.summary, /### Issues[\s\S]*### Requirements\n\| Status \| Criterion \| Evidence \|[\s\S]*❌ not met \| - Exports are limited to admins/);
  assert.equal(result.metadata.requirementsNotMet, 1);
  assert.ok(result.metadata.coverageLimits?.includes("Some linked-ticket requirements could not be confirmed against the code"));
  // The approval rule blocks on the grounded "not met" even if everything else were perfect.
  const clean = { supported: true, open: true, draft: false, head: "h", reviewedHead: "h", latest: true, completed: true, coverageLimits: [], unresolved: 0, assessment: { risk: "low" as const, confidence: 1, reason: "Small change with full evidence and coverage." }, author: "a", changedPaths: ["src/export.ts"], humanChangeRequested: false, requiredChecksKnown: true, checks: [], nativeRequiredChecks: [], runtimeRequired: false, runtimePassed: false };
  const policy = { ...approvalDefaults, enabled: true };
  assert.deepEqual(approvalBlockers(policy, clean), []);
  assert.deepEqual(approvalBlockers(policy, { ...clean, requirementsNotMet: result.metadata.requirementsNotMet }), ["Linked ticket requirements are not met"]);
});

test("the Requirements section toggle turns the check off; reviews without tickets never run it", async () => {
  const off = new RequirementsModel();
  const result = await reviewChange({ ...input, settings: { categories: ["correctness"], summarySections: ["overview", "findings"] } }, off);
  assert.equal(off.tasks.includes("requirements"), false);
  assert.doesNotMatch(result.summary, /### Requirements/);
  assert.equal(result.metadata.requirementsNotMet, undefined);
  const noTickets = new RequirementsModel();
  const plain = await reviewChange({ ...input, files: [input.files[0]], settings: { categories: ["correctness"] } }, noTickets);
  assert.equal(noTickets.tasks.includes("requirements"), false);
  assert.doesNotMatch(plain.summary, /### Requirements/);
  // A failing check degrades with a note instead of failing the review.
  const broken = new (class extends RequirementsModel { async generate<T>(request: ModelRequest, schema: z.ZodType<T>) { if (request.task === "requirements") throw new Error("model unavailable"); return super.generate(request, schema); } })();
  const degraded = await reviewChange({ ...input, settings: { categories: ["correctness"] } }, broken);
  assert.ok(degraded.metadata.coverageLimits?.includes("Linked-ticket requirements could not be checked"));
});
