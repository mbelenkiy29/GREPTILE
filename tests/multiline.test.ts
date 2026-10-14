import { test } from "node:test";
import assert from "node:assert/strict";
import { commentRange, rightSideHunks } from "../src/engine/patch-lines";
import { Github } from "../src/github";
import type { Finding } from "../src/engine/types";

const patch = "@@ -1,4 +1,5 @@\n export function total(amount: number) {\n-  return amount;\n+  const cents = amount;\n+  return cents / 100;\n }\n@@ -20,2 +21,3 @@\n export function fee() {\n+  return 2;\n }";
test("multi-line ranges stay within one hunk's right side; ranges leaving the hunk fall back to one line", () => {
  assert.deepEqual([...rightSideHunks(patch)], [[1, 0], [2, 0], [3, 0], [4, 0], [21, 1], [22, 1], [23, 1]]);
  assert.deepEqual(commentRange(patch, 2, 3), { start: 2, end: 3 });
  assert.deepEqual(commentRange(patch, 1, 4), { start: 1, end: 4 }, "context lines inside the hunk may be included");
  assert.deepEqual(commentRange(patch, 3, 21), { start: 3, end: 3 }, "spanning two hunks falls back");
  assert.deepEqual(commentRange(patch, 4, 6), { start: 4, end: 4 }, "leaving the hunk falls back");
  assert.deepEqual(commentRange(patch, 9, 10), { start: 9, end: 9 });
  assert.deepEqual(commentRange(patch, 3, 3), { start: 3, end: 3 });
});

const head = "a".repeat(40);
const finding = (startLine: number, endLine: number, fingerprint: string): Finding => ({
  title: "Total returns dollars instead of cents", description: "Dividing by 100 converts the integer cents total into dollars.", severity: "high", confidence: 0.95, category: "correctness",
  filePath: "price.ts", startLine, endLine, evidence: [{ filePath: "price.ts", startLine: 3, quote: "  return cents / 100;" }], impact: "Callers charge one hundredth of the amount.", suggestedFix: "Return the integer cents amount.", symbol: "total",
  fingerprint, agent: "correctness", commitSha: head,
  suggestion: { startLine, endLine, original: "x", replacement: "  const cents = amount;\n  return cents;" },
});
test("GitHub publishes start_line/start_side for in-hunk ranges, single lines otherwise, and maps both back", async (t) => {
  const inside = finding(2, 3, "a".repeat(64)), outside = finding(3, 6, "b".repeat(64));
  let posted: { comments: Record<string, unknown>[] } | undefined;
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === "/repos/o/r/pulls/1") return Response.json({ state: "open", head: { sha: head } });
    if (path.endsWith("/files")) return Response.json([{ filename: "price.ts", patch }]);
    if (path.endsWith("/reviews") && options.method === "POST") { posted = JSON.parse(String(options.body)); return Response.json({ id: 100, commit_id: head, user: { login: "openreview[bot]" } }); }
    if (path.endsWith("/reviews")) return Response.json([]);
    if (path.endsWith("/reviews/100/comments")) return Response.json(posted!.comments.map((c, i) => ({ id: 10 + i, body: c.body, user: { login: "openreview[bot]" }, path: c.path, line: c.line, start_line: c.start_line ?? null, commit_id: head, pull_request_review_id: 100 })));
    throw new Error("Unexpected endpoint " + path);
  });
  const result = await new Github("fixture", undefined, async () => "openreview").publish("o/r", 1, head, "Summary", [inside, outside], "run", "concise");
  const [multi, single] = posted!.comments;
  assert.deepEqual([multi.start_line, multi.start_side, multi.line, multi.side], [2, "RIGHT", 3, "RIGHT"]);
  assert.match(String(multi.body), /```suggestion\n  const cents = amount;\n  return cents;\n```/, "a multi-line suggestion renders when the comment spans its range");
  assert.deepEqual([single.start_line, single.line], [undefined, 3]);
  assert.doesNotMatch(String(single.body), /```suggestion/, "a suggestion that cannot match the single-line fallback is omitted");
  assert.deepEqual(result.comments, [{ id: 10, fingerprint: "a".repeat(64) }, { id: 11, fingerprint: "b".repeat(64) }]);
});
