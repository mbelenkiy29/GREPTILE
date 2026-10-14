import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { incrementalDiff } from "../src/incremental";
import { reviewChange } from "../src/engine/review";
import { Github } from "../src/github";
import type { Candidate, ChangedFile, ModelProvider, ModelRequest } from "../src/engine/types";

const prDiff: ChangedFile[] = [
  { path: "src/a.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n line1\n-old2\n+new2\n line3" },
  { path: "src/b.ts", status: "added", patch: "@@ -0,0 +1,2 @@\n+b1\n+b2" },
];
const newCommits: ChangedFile[] = [{ path: "src/b.ts", status: "modified", patch: "@@ -1,1 +1,2 @@\n b1\n+b2" }, { path: "src/reverted.ts", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" }];

test("incremental scope: ancestor heads review only new commits; force pushes and gaps review everything", () => {
  const ahead = incrementalDiff(prDiff, "p".repeat(40), { status: "ahead", commits: 2, complete: true, files: newCommits });
  assert.equal(ahead.incremental, true);
  assert.deepEqual(ahead.diff.map((d) => d.path), ["src/b.ts"], "files the PR no longer changes are dropped");
  assert.match(ahead.note!, /Incremental review: 2 new commits since ppppppp changed 1 file/);
  for (const status of ["diverged", "behind"] as const) {
    const forced = incrementalDiff(prDiff, "p".repeat(40), { status, commits: 0, complete: true, files: newCommits });
    assert.equal(forced.incremental, false);
    assert.equal(forced.diff, prDiff);
    assert.match(forced.note!, /force-pushed or rebased/);
  }
  assert.match(incrementalDiff(prDiff, "p".repeat(40), { status: "ahead", commits: 400, complete: false, files: [] }).note!, /too large to compare/);
  assert.match(incrementalDiff(prDiff, "p".repeat(40), "unavailable").note!, /Could not compare/);
  assert.deepEqual(incrementalDiff(prDiff, undefined, undefined), { diff: prDiff, incremental: false });
  assert.match(incrementalDiff(prDiff, "p".repeat(40), { status: "ahead", commits: 1, complete: true, files: [newCommits[1]] }).note!, /no longer changes/);
});

const usage = (task: string) => ({ task, provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 1, latencyMs: 0, estimatedCost: 0, cached: false });
test("incremental reviews anchor findings on lines the full PR still changes and summarize every PR file", async () => {
  const head = "h".repeat(40);
  const files = [{ path: "src/b.ts", sha: head, content: "b1\nb2" }, { path: "src/a.ts", sha: head, content: "line1\nnew2\nline3" }];
  const candidate = (startLine: number): Candidate => ({ title: "Second value is wrong", description: "The added value breaks the expected sequence.", severity: "high", confidence: 0.95, category: "correctness", filePath: "src/b.ts", startLine, endLine: startLine, evidence: [{ filePath: "src/b.ts", startLine, quote: startLine === 2 ? "b2" : "b1" }], impact: "Callers read the wrong value.", suggestedFix: "Restore the expected value.", symbol: "b" });
  const incrementalDiffForTest: ChangedFile[] = [{ path: "src/b.ts", status: "modified", patch: "@@ -1,1 +1,2 @@\n+b1\n+b2" }];
  const model: ModelProvider = { async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    const value = request.task === "review:correctness" ? { findings: [candidate(2), { ...candidate(1), title: "First value line flagged" }] } : request.task.startsWith("review:") ? { findings: [] } : request.task === "verify" ? { decisions: (request.input as { candidates: unknown[] }).candidates.map((_, index) => ({ index, publish: true, reason: "The new commit changes this value incorrectly.", confidence: 0.95 })) } : request.task === "diagram" ? { diagram: null } : { summary: "The new commit adjusts the second value in b.ts.", reviewScore: { value: 2, reason: "A verified high severity defect must be fixed." } };
    return { value: schema.parse(value), usage: usage(request.task) };
  } };
  // Line 1 changed in the new commits' diff but, per the full PR diff, b.ts lines 1–2 are both added; restrict full diff to line 2 only.
  const fullDiff: ChangedFile[] = [prDiff[0], { path: "src/b.ts", status: "added", patch: "@@ -1,1 +1,2 @@\n b1\n+b2" }];
  const result = await reviewChange({ repository: "o/r", baseSha: "a".repeat(40), headSha: head, title: "More b", description: "", rules: [], mode: "fast", files, diff: incrementalDiffForTest, fullDiff }, model);
  assert.deepEqual(result.findings.map((f) => f.startLine), [2]);
  assert.ok(result.metadata.suppressions!.some((s) => s.title === "First value line flagged" && /changed-line/.test(s.reason)));
  assert.match(result.summary, /\| `src\/a.ts` \|/, "the summary file table lists every PR file");
});

test("GitHub compare reports ancestry, completeness and changed files", async (t) => {
  t.mock.method(console, "log", () => {});
  let response: unknown = { status: "ahead", total_commits: 2, files: [{ filename: "src/b.ts", status: "modified", patch: "@@ -1 +1,2 @@\n b1\n+b2", changes: 1 }] };
  t.mock.method(globalThis, "fetch", async (url: string) => { assert.match(new URL(url).pathname, /^\/repos\/o\/r\/compare\/p{40}\.\.\.h{40}$/); return Response.json(response); });
  const github = new Github("fixture");
  assert.deepEqual(await github.compare("o/r", "p".repeat(40), "h".repeat(40)), { status: "ahead", commits: 2, complete: true, files: [{ path: "src/b.ts", previousPath: undefined, patch: "@@ -1 +1,2 @@\n b1\n+b2", status: "modified" }] });
  response = { status: "diverged", total_commits: 1, files: [{ filename: "big.ts", status: "modified", changes: 9000 }] };
  assert.equal((await github.compare("o/r", "p".repeat(40), "h".repeat(40))).complete, false);
});

test("thread hygiene resolves only OpenReview-started, unresolved finding threads, idempotently", async (t) => {
  t.mock.method(console, "log", () => {});
  const threads = [
    { id: "T_bot", isResolved: false, comments: { nodes: [{ databaseId: 10, author: { login: "openreview" } }] } },
    { id: "T_human", isResolved: false, comments: { nodes: [{ databaseId: 11, author: { login: "alice" } }] } },
    { id: "T_done", isResolved: true, comments: { nodes: [{ databaseId: 12, author: { login: "openreview" } }] } },
  ];
  const replies: { parent: number; body: string }[] = [], resolvedIds: string[] = [];
  const restComments: { id: number; body: string; user: { login: string }; in_reply_to_id?: number }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const u = new URL(url);
    if (u.pathname === "/graphql") {
      const { query, variables } = JSON.parse(String(options.body));
      if (query.startsWith("mutation")) { resolvedIds.push(variables.id); const thread = threads.find((th) => th.id === variables.id)!; thread.isResolved = true; return Response.json({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } }); }
      return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } });
    }
    if (u.pathname === "/repos/o/r/pulls/1/comments") return Response.json(restComments);
    const reply = /^\/repos\/o\/r\/pulls\/1\/comments\/(\d+)\/replies$/.exec(u.pathname);
    if (reply && options.method === "POST") { const body = JSON.parse(String(options.body)).body; replies.push({ parent: Number(reply[1]), body }); const c = { id: 100 + replies.length, body, user: { login: "openreview[bot]" }, in_reply_to_id: Number(reply[1]) }; restComments.push(c); return Response.json(c); }
    throw new Error("Unexpected endpoint " + u.pathname);
  });
  const github = new Github("fixture", undefined, async () => "openreview");
  const items = [10, 11, 12, 99].map((commentId) => ({ commentId, body: "Resolved: fixed in `abc1234`.", marker: "resolved:fp" + commentId + ":abc" }));
  assert.deepEqual(await github.resolveFindingThreads("o/r", 1, items), { resolved: 1, skipped: 3 });
  assert.deepEqual(resolvedIds, ["T_bot"]);
  assert.deepEqual(replies.map((r) => r.parent), [10]);
  assert.match(replies[0].body, /<!-- openreview:resolved:fp10:abc -->/);
  // A retry neither replies nor resolves again.
  assert.deepEqual(await github.resolveFindingThreads("o/r", 1, items), { resolved: 0, skipped: 4 });
  assert.equal(replies.length, 1);
  assert.deepEqual(resolvedIds, ["T_bot"]);
  assert.equal(threads[1].isResolved, false, "human-started threads are never resolved");
});
