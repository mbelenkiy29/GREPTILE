import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { memoryToolbox } from "../src/engine/agent";
import { reviewChange } from "../src/engine/review";
import { cacheDirectory, localAgentState, stateFile } from "../src/local-review-state";
import { inlineReport } from "../src/inline-output";
import type { Finding, ModelProvider, ModelRequest, ReviewInput, ToolRequest, ToolTurn } from "../src/engine/types";

test("the state lives in the OS cache directory, one file per checkout and base", () => {
  assert.equal(cacheDirectory({}, "darwin", "/Users/a"), "/Users/a/Library/Caches/openreview");
  assert.equal(cacheDirectory({ XDG_CACHE_HOME: "/var/cache/u" }, "linux", "/home/a"), "/var/cache/u/openreview");
  assert.equal(cacheDirectory({ XDG_CACHE_HOME: "relative" }, "linux", "/home/a"), "/home/a/.cache/openreview");
  assert.equal(cacheDirectory({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a"), path.join("C:\\Users\\a\\AppData\\Local", "openreview", "cache"));
  const a = stateFile("/c", "/repo", "b".repeat(40)), b = stateFile("/c", "/repo", "c".repeat(40));
  assert.notEqual(a, b);
  assert.match(path.basename(a), /^agent-state-[0-9a-f]{24}\.json$/);
});

const content = "export function total(c) {\n  return c / 100;\n}";
const input = (head: string): ReviewInput => ({ repository: "o/r", baseSha: "a".repeat(40), headSha: head, title: "t", description: "", rules: [], mode: "standard", files: [{ path: "total.ts", sha: "1", content }], diff: [{ path: "total.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function total(c) {\n-  return c;\n+  return c / 100;\n }" }] });
// Tool-calling fake: reads a file each turn for `turnsBeforeDone` turns, then finishes. `interruptAt`
// simulates Ctrl-C during that model call.
class Investigator implements ModelProvider {
  calls = 0;
  constructor(private turnsBeforeDone: number, private interruptAt?: { call: number; controller: AbortController }) {}
  async runTools(request: ToolRequest): Promise<ToolTurn> {
    this.calls++;
    if (this.interruptAt?.call === this.calls) { this.interruptAt.controller.abort(); throw new DOMException("The operation was aborted.", "AbortError"); }
    const done = request.messages.filter((m) => m.role === "assistant").length >= this.turnsBeforeDone;
    const toolCalls = done ? [] : [{ id: "c" + this.calls, name: "read_file", input: { path: "total.ts" } }];
    return { content: done ? "Refuted: nothing to report." : "", toolCalls, stopReason: done ? "end_turn" : "tool_use", message: { role: "assistant", content: done ? "Refuted: nothing to report." : "", toolCalls }, usage: { task: request.task, provider: "f", model: "f", inputTokens: 10, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  }
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    const value = request.task === "diagram" ? { diagram: null } : { reviewScore: { value: 4, reason: "No verified defects were found in the reviewed change." }, summary: "Totals are divided by one hundred now." };
    return { value: schema.parse(value), usage: { task: request.task, provider: "f", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  }
}
const head = "b".repeat(40), moved = "c".repeat(40);
const run = (model: ModelProvider, state: ReturnType<typeof localAgentState>, headSha: string, signal?: AbortSignal) => reviewChange(input(headSha), model, async () => {}, signal, { engine: "agentic", tools: memoryToolbox(input(headSha).files, headSha), agent: state.hooks });

test("an interrupted agentic review resumes from its saved state when HEAD is unchanged", async () => {
  const file = stateFile(await mkdtemp(path.join(tmpdir(), "or-resume-")), "/repo", "a".repeat(40));
  const controller = new AbortController();
  const first = localAgentState(file, { resume: false, headSha: head });
  await assert.rejects(run(new Investigator(5, { call: 3, controller }), first, head, controller.signal), /abort/i);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual([saved.headSha, saved.turns, saved.toolCalls, saved.done], [head, 2, 2, false]);
  assert.equal((await stat(file)).mode & 0o777, 0o600, "owner-only state file");
  // Same head with --resume: continues from turn 2 instead of starting over.
  const model = new Investigator(5);
  const second = localAgentState(file, { resume: true, headSha: head });
  const result = await run(model, second, head);
  assert.equal(second.outcome(), "resumed");
  assert.deepEqual([result.metadata.agentRun?.resumes, result.metadata.agentRun?.turns, result.metadata.agentRun?.stopReason], [1, 6, "completed"]);
  assert.equal(model.calls, 4, "only the remaining turns were run");
  await second.clear();
  await assert.rejects(stat(file));
});

test("a moved HEAD discards the saved state and restarts; without --resume saved state is ignored and replaced", async () => {
  const file = stateFile(await mkdtemp(path.join(tmpdir(), "or-resume-")), "/repo", "a".repeat(40));
  const controller = new AbortController();
  await assert.rejects(run(new Investigator(5, { call: 2, controller }), localAgentState(file, { resume: false, headSha: head }), head, controller.signal));
  const restarted = localAgentState(file, { resume: true, headSha: moved });
  const model = new Investigator(2);
  const result = await run(model, restarted, moved);
  assert.equal(restarted.outcome(), "restarted");
  assert.deepEqual([result.metadata.agentRun?.resumes, result.metadata.agentRun?.turns], [0, 3]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).headSha, moved, "the new run saved its own state");
  // No --resume: a saved state for the same head is not used.
  const fresh = localAgentState(file, { resume: false, headSha: moved });
  assert.equal(await fresh.hooks.load!(), null);
  assert.equal(fresh.outcome(), "fresh");
  // Unreadable or invalid state is treated as absent.
  await writeFile(file, "{ broken");
  assert.equal(await localAgentState(file, { resume: true, headSha: moved }).hooks.load!(), null);
  await writeFile(file, JSON.stringify({ version: 2 }));
  assert.equal(await localAgentState(file, { resume: true, headSha: moved }).hooks.load!(), null);
});

const finding = (extra: Partial<Finding>): Finding => ({ title: "Totals are divided before storage", description: "total() returns dollars,\nbut callers store cents.", severity: "high", confidence: 0.9, category: "correctness", filePath: "src/total.ts", startLine: 3, endLine: 3, evidence: [], impact: "Amounts shrink.", suggestedFix: "Return cents.", symbol: "total", agent: "correctness", fingerprint: "f1", commitSha: "b".repeat(40), ...extra } as Finding);
const source = { path: "src/total.ts", content: ["// totals", "export function total(c) {", "  return c / 100;", "}", "", "export const x = 1;"].join("\n") };

test("inline output: file:line blocks with marked context, priority and tags (snapshot)", () => {
  assert.equal(inlineReport([finding({})], [source]), [
    "src/total.ts:3  [P1 high] Totals are divided before storage",
    "  1 | // totals",
    "  2 | export function total(c) {",
    "> 3 |   return c / 100;",
    "  4 | }",
    "  5 |",
    "  total() returns dollars,",
    "  but callers store cents.",
    "  Fix: Return cents.",
    "",
    "1 finding.",
  ].join("\n"));
  const security = finding({ title: "Token logged", severity: "critical", category: "security", startLine: 1, endLine: 2, filePath: "src/total.ts", description: "Logs the token.", suggestedFix: "Remove the log." });
  const missing = finding({ title: "Caller multiplies", severity: "low", filePath: "src/gone.ts", startLine: 9, endLine: 9, description: "Outside the checkout.", suggestedFix: "Check the caller." });
  assert.equal(inlineReport([security, missing], [source]), [
    "src/total.ts:1-2  [P0 critical, Security] Token logged",
    "> 1 | // totals",
    "> 2 | export function total(c) {",
    "  3 |   return c / 100;",
    "  4 | }",
    "  Logs the token.",
    "  Fix: Remove the log.",
    "",
    "src/gone.ts:9  [P3 low] Caller multiplies",
    "  Outside the checkout.",
    "  Fix: Check the caller.",
    "",
    "2 findings.",
  ].join("\n"));
  assert.equal(inlineReport([], [source]), "No findings.");
});
