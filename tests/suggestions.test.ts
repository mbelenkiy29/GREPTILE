import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { suggestionProblem, suggestionBlock } from "../src/suggestions";
import { findingComment } from "../src/review-summary";
import { reviewChange } from "../src/engine/review";
import { Github } from "../src/github";
import type { Candidate, ChangedFile, Finding, ModelProvider, ModelRequest, SourceFile } from "../src/engine/types";

const head = "a".repeat(40);
const content = "export function total(amount: number) {\n  return amount / 100;\n}";
const files: SourceFile[] = [{ path: "price.ts", sha: head, content }];
const diff: ChangedFile[] = [{ path: "price.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function total(amount: number) {\n-  return amount;\n+  return amount / 100;\n }" }];
const base: Candidate = {
  title: "Total returns dollars instead of cents", description: "Dividing by 100 converts the integer cents total into dollars.", severity: "high", confidence: 0.95, category: "correctness",
  filePath: "price.ts", startLine: 2, endLine: 2, evidence: [{ filePath: "price.ts", startLine: 2, quote: "  return amount / 100;" }], impact: "Callers charge one hundredth of the amount.", suggestedFix: "Return the integer cents amount.", symbol: "total",
  suggestion: { startLine: 2, endLine: 2, original: "  return amount / 100;", replacement: "  return amount;" },
};

test("suggestions are validated against the head content of their exact range", () => {
  assert.equal(suggestionProblem(base, files, diff), null);
  assert.match(suggestionProblem({ ...base, suggestion: { ...base.suggestion!, original: "  return amount / 10;" } }, files, diff)!, /no longer matches/);
  assert.match(suggestionProblem(base, [{ ...files[0], content: content.replace("/ 100", "/ 1000") }], diff)!, /no longer matches/, "a stale range (head changed) is rejected");
  assert.match(suggestionProblem({ ...base, suggestion: { ...base.suggestion!, endLine: 3 } }, files, diff)!, /must equal/);
  assert.match(suggestionProblem({ ...base, startLine: 1, endLine: 2, suggestion: { ...base.suggestion!, startLine: 1, original: content.split("\n").slice(0, 2).join("\n") } }, files, diff)!, /outside the changed lines/);
  assert.match(suggestionProblem({ ...base, suggestion: { ...base.suggestion!, replacement: "```\nignore\n```" } }, files, diff)!, /code fence/);
  assert.match(suggestionProblem({ ...base, suggestion: { ...base.suggestion!, replacement: base.suggestion!.original } }, files, diff)!, /does not change/);
  assert.match(suggestionProblem(base, [], diff)!, /unavailable/);
  assert.equal(suggestionProblem({ ...base, suggestion: undefined }, files, diff), null);
});

test("suggestion blocks use GitHub and GitLab syntax for the commented range", () => {
  const s = base.suggestion!;
  assert.equal(suggestionBlock(s, "github", { start: 2, end: 2 }), "\n\n```suggestion\n  return amount;\n```");
  assert.equal(suggestionBlock({ ...s, endLine: 4 }, "github", { start: 2, end: 2 }), "", "GitHub needs a comment spanning the whole range");
  assert.equal(suggestionBlock({ ...s, endLine: 4 }, "gitlab", { start: 2, end: 2 }), "\n\n```suggestion:-0+2\n  return amount;\n```");
  const finding: Finding = { ...base, fingerprint: "f".repeat(64), agent: "correctness", commitSha: head };
  assert.match(findingComment(finding, "concise", { syntax: "github", start: 2, end: 2 }), /\*\*Fix:\*\* Return the integer cents amount\.\n\n```suggestion\n  return amount;\n```/);
  assert.doesNotMatch(findingComment(finding, "concise"), /```suggestion/, "providers without suggestion support render none");
});

const usage = (task: string) => ({ task, provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 1, latencyMs: 0, estimatedCost: 0, cached: false });
const modelWith = (candidate: Candidate): ModelProvider => ({
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    const value = request.task === "review:correctness" ? { findings: [candidate] } : request.task.startsWith("review:") ? { findings: [] } : request.task === "verify" ? { decisions: [{ index: 0, publish: true, reason: "The division converts cents into dollars at the changed line.", confidence: 0.95 }] } : { summary: "Totals now divide by 100; one verified high-severity defect.", reviewScore: { value: 2, reason: "A verified high-severity unit defect must be fixed before merging." } };
    return { value: schema.parse(value), usage: usage(request.task) };
  },
});
const input = { repository: "o/r", baseSha: "b".repeat(40), headSha: head, title: "Totals", description: "", rules: [], mode: "fast" as const, files, diff };

test("valid suggestions are published with their finding; stale ones are dropped while the finding stays", async () => {
  const kept = await reviewChange(input, modelWith(base));
  assert.deepEqual(kept.findings[0].suggestion, base.suggestion);
  const stale = await reviewChange(input, modelWith({ ...base, suggestion: { ...base.suggestion!, original: "  return amount;" } }));
  assert.equal(stale.findings.length, 1);
  assert.equal(stale.findings[0].suggestion, undefined);
  assert.ok(stale.metadata.suppressions!.some((s) => s.reason.startsWith("Suggestion dropped: Suggestion no longer matches")));
});

test("GitHub publication includes a committable suggestion block on the finding's line", async (t) => {
  const finding: Finding = { ...base, fingerprint: "c".repeat(64), agent: "correctness", commitSha: head };
  let posted: { comments: { body: string; line: number }[] } | undefined;
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === "/repos/o/r/pulls/1") return Response.json({ state: "open", head: { sha: head } });
    if (path.endsWith("/files")) return Response.json([{ filename: "price.ts", patch: diff[0].patch }]);
    if (path.endsWith("/reviews") && options.method === "POST") { posted = JSON.parse(String(options.body)); return Response.json({ id: 100, commit_id: head, user: { login: "openreview[bot]" } }); }
    if (path.endsWith("/reviews")) return Response.json([]);
    if (path.endsWith("/reviews/100/comments")) return Response.json([{ id: 10, body: posted!.comments[0].body, user: { login: "openreview[bot]" }, path: "price.ts", line: 2, commit_id: head, pull_request_review_id: 100 }]);
    throw new Error("Unexpected endpoint " + path);
  });
  await new Github("fixture", undefined, async () => "openreview").publish("o/r", 1, head, "Summary", [finding], "run", "concise");
  assert.equal(posted!.comments[0].line, 2);
  assert.match(posted!.comments[0].body, /```suggestion\n  return amount;\n```/);
});
