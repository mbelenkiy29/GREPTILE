import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewSummary } from "../src/review-summary";
import { reviewSummarySchema } from "../src/engine/review";
import { summarySections } from "../src/review-settings";
import { Github, summaryMarker } from "../src/github";
import type { Finding } from "../src/engine/types";

const head = "a".repeat(40);
const finding = (severity: Finding["severity"], title: string, startLine: number, endLine = startLine): Finding => ({
  title, description: "Concrete defect description for the table.", severity, confidence: 0.95, category: "correctness", filePath: "src/total.ts", startLine, endLine,
  evidence: [{ filePath: "src/total.ts", startLine, quote: "x" }], impact: "Impact text.", suggestedFix: "Fix text.", symbol: "total", fingerprint: title.slice(0, 8), agent: "correctness", commitSha: head,
});
const data = {
  overview: "Totals are now computed in a shared helper.",
  files: [{ path: "src/total.ts", status: "modified", patch: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d" }, { path: "tests/total.test.ts", status: "added", patch: "@@ -0,0 +1 @@\n+t" }, { path: "src/a|b.ts", status: "modified", patch: "" }],
  fileSummaries: [{ path: "src/total.ts", summary: "Moves total computation into a helper | with pipes." }],
  findings: [finding("medium", "Rounding drops a cent", 9), finding("critical", "Totals become dollars", 3, 5)],
  resolved: [], score: { value: 1, reason: "A critical currency defect blocks merging. Further detail that is not shown." },
  assessment: { risk: "high" as const, confidence: 0.9, reason: "Monetary totals change for every order." }, runtimeEvidence: undefined,
  coverageLimits: ["Some review categories were disabled"], contextCount: 3, candidates: 4, suppressed: 2,
  skippedFiles: [{ path: "package-lock.json", reason: "Lower-risk file beyond the fast review limit of 200 files" }],
  sourceLink: (path: string, start: number, end: number) => `https://github.com/acme/shop/blob/${head}/${path}#L${start}${end > start ? "-L" + end : ""}`,
};

test("summary renders overview, file and issue tables, n/5 confidence, risk, skipped files and coverage (snapshot)", () => {
  const expected = [
    // G1: the verdict opens the summary; the score shows because the score section is on.
    "**Needs changes** · Confidence score **1/5**",
    "### Overview\nTotals are now computed in a shared helper.",
    "### Files changed\n| File | Change |\n| --- | --- |\n| `src/total.ts` | Moves total computation into a helper \\| with pipes. |\n| `tests/total.test.ts` | added · +1 −0 |\n| `src/a|b.ts` | modified · +0 −0 |",
    `### Issues\n| Severity | Location | Issue |\n| --- | --- | --- |\n| **critical** | [\`src/total.ts:3–5\`](<https://github.com/acme/shop/blob/${head}/src/total.ts#L3-L5>) | Totals become dollars |\n| **medium** | [\`src/total.ts:9\`](<https://github.com/acme/shop/blob/${head}/src/total.ts#L9>) | Rounding drops a cent |`,
    "### Confidence score\n**1/5** — A critical currency defect blocks merging.",
    "### Risk assessment\nhigh · Confidence 90%\n\nMonetary totals change for every order.",
    "### Resolved findings\nNo previously reported findings were confirmed resolved in this review.",
    "### Skipped files\n- `package-lock.json` · Lower-risk file beyond the fast review limit of 200 files",
    "### Test source\n- `tests/total.test.ts`",
    "### Test execution\nNot executed by OpenReview. Test files and CI metadata are context, not proof of a successful test run.",
    "### Coverage\n3 changed files; 3 retrieved context files. 4 candidates; 2 verified findings; 2 suppressed.\n\n- Some review categories were disabled",
  ].join("\n\n");
  assert.equal(reviewSummary(data), expected);
  assert.deepEqual([...summarySections], ["overview", "affectedAreas", "diagram", "findings", "score", "risk", "resolved", "skipped", "testSource"]);
  assert.doesNotMatch(reviewSummary(data), /### Sequence diagram/, "the diagram section is omitted when no diagram was generated");
});

test("summary sections toggle independently; skipped files fall back into coverage when their section is off", () => {
  const minimal = reviewSummary(data, ["findings"]);
  // G1: the verdict line always comes first; without the score section it carries no score.
  assert.match(minimal, /^\*\*Needs changes\*\*\n\n### Issues\n/);
  assert.doesNotMatch(minimal, /### Overview|### Files changed|### Confidence score|### Skipped files/);
  assert.match(minimal, /### Coverage[\s\S]*Skipped files:\n- `package-lock.json`/);
  assert.match(reviewSummary({ ...data, findings: [], sourceLink: undefined }, ["findings"]), /No verified findings/);
  assert.match(reviewSummary({ ...data, sourceLink: () => "javascript:alert(1)" }, ["findings"]), /\| \*\*critical\*\* \| `src\/total.ts:3–5` \|/, "non-HTTPS links are not rendered");
  const many = { ...data, files: Array.from({ length: 65 }, (_, i) => ({ path: `f${i}.ts`, status: "added", patch: "" })) };
  assert.match(reviewSummary(many, ["affectedAreas"]), /…and 5 more changed files\./);
});

test("file summaries must describe supplied diff paths and obey execution-claim rules", () => {
  const schema = reviewSummarySchema(undefined, undefined, undefined, false, ["src/total.ts"]);
  assert.ok(schema.safeParse({ summary: data.overview, files: [{ path: "src/total.ts", summary: "Moves totals into a helper." }] }).success);
  assert.equal(schema.safeParse({ summary: data.overview, files: [{ path: "src/other.ts", summary: "Invented file." }] }).success, false);
  assert.equal(schema.safeParse({ summary: data.overview, files: [{ path: "src/total.ts", summary: "All regression tests passed after this change." }] }).success, false);
});

test("GitHub keeps exactly one summary comment, edited in place across runs, retries, spoofed markers and legacy duplicates", async (t) => {
  t.mock.method(console, "log", () => {});
  const issueComments: { id: number; body: string; user: { login: string } }[] = [{ id: 1, body: "spoof " + summaryMarker, user: { login: "mallory" } }];
  const reviews: { id: number; body: string; commit_id: string; state: string; user: { login: string } }[] = [];
  let reviewPosts = 0, summaryPosts = 0, summaryEdits = 0, posted: { comments: { body: string }[] } | undefined;
  const patch = "@@ -1,2 +1,2 @@\n a\n-b\n+c";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === "/repos/o/r/pulls/1") return Response.json({ state: "open", head: { sha: head } });
    if (path.endsWith("/files")) return Response.json([{ filename: "src/total.ts", patch }]);
    if (path === "/repos/o/r/issues/1/comments" && options.method === "POST") { summaryPosts++; const c = { id: 100 + summaryPosts, body: JSON.parse(String(options.body)).body, user: { login: "openreview[bot]" } }; issueComments.push(c); return Response.json(c); }
    if (path === "/repos/o/r/issues/1/comments") return Response.json(issueComments);
    if (/^\/repos\/o\/r\/issues\/comments\/\d+$/.test(path) && options.method === "PATCH") { summaryEdits++; const c = issueComments.find((c) => path.endsWith("/" + c.id))!; c.body = JSON.parse(String(options.body)).body; return Response.json(c); }
    if (path.endsWith("/reviews") && options.method === "POST") { reviewPosts++; posted = JSON.parse(String(options.body)); const r = { id: 200 + reviewPosts, body: JSON.parse(String(options.body)).body, commit_id: head, state: "COMMENTED", user: { login: "openreview[bot]" } }; reviews.push(r); return Response.json(r); }
    if (path.endsWith("/reviews")) return Response.json(reviews);
    if (/\/reviews\/\d+\/comments$/.test(path)) return Response.json(posted!.comments.map((c, i) => ({ id: 300 + i, body: c.body, user: { login: "openreview[bot]" }, path: "src/total.ts", line: 2, commit_id: head, pull_request_review_id: Number(path.split("/").at(-2)) })));
    throw new Error("Unexpected endpoint " + path);
  });
  const github = new Github("fixture", undefined, async () => "openreview");
  const f = { ...finding("high", "Wrong total", 2), filePath: "src/total.ts", fingerprint: "f".repeat(64) };
  const first = await github.publish("o/r", 1, head, "Run one summary", [f], "run-1");
  assert.equal(first.id, 201);
  assert.deepEqual([reviewPosts, summaryPosts, summaryEdits], [1, 1, 0]);
  const mine = () => issueComments.filter((c) => c.user.login === "openreview[bot]");
  assert.match(mine()[0].body, /Run one summary[\s\S]*\*\*Last reviewed commit:\*\* \[`aaaaaaa`\]\(https:\/\/github\.com\/o\/r\/commit\/a{40}\)/);
  assert.match(posted!.comments[0].body, /openreview-finding/);
  assert.match(reviews[0].body, /OpenReview posted 1 inline finding on `aaaaaaa`/);
  // Retrying the same run republishes nothing.
  assert.equal((await github.publish("o/r", 1, head, "Run one summary", [f], "run-1")).reused, true);
  assert.deepEqual([reviewPosts, summaryPosts, summaryEdits], [1, 1, 0]);
  // A later run with no findings edits the same summary comment and creates no review.
  const second = await github.publish("o/r", 1, head, "Run two summary", [], "run-2");
  assert.deepEqual([reviewPosts, summaryPosts, summaryEdits], [1, 1, 1]);
  assert.deepEqual(second, { id: 101, reused: false, comments: [] });
  assert.equal(mine().length, 1);
  assert.match(mine()[0].body, /Run two summary/);
  assert.equal(issueComments[0].body, "spoof " + summaryMarker, "another author's marker is never edited");
  // Legacy duplicates from older versions: only the latest is edited, nothing new is posted.
  issueComments.push({ id: 150, body: "legacy " + summaryMarker, user: { login: "openreview[bot]" } });
  await github.publish("o/r", 1, head, "Run three summary", [], "run-3");
  assert.deepEqual([summaryPosts, summaryEdits], [1, 2]);
  assert.match(issueComments.find((c) => c.id === 150)!.body, /Run three summary/);
});
