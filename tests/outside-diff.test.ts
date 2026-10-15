import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { grounded, groundedOutside, reviewChange } from "../src/engine/review";
import { inlineFindings, reviewSummary } from "../src/review-summary";
import { reviewVerdict, verdictLabels, verdictLine } from "../src/verdict";
import { Github } from "../src/github";
import type { Candidate, Finding, ModelProvider, ModelRequest, ReviewInput } from "../src/engine/types";

// Multi-hop fixture: cart.ts now returns cents; the untouched payments.ts still multiplies by 100.
const cart = "export function total(items) {\n  return items.reduce((sum, i) => sum + i.cents, 0);\n}";
const payments = "import { total } from './cart';\nexport function charge(items) { return gateway.charge(total(items) * 100); }";
const input: ReviewInput = {
  repository: "fixture/outside", baseSha: "base", headSha: "head", title: "Totals in cents", description: "",
  files: [{ path: "cart.ts", sha: "1", content: cart }, { path: "payments.ts", sha: "2", content: payments }],
  diff: [{ path: "cart.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function total(items) {\n-  return items.reduce((sum, i) => sum + i.price, 0);\n+  return items.reduce((sum, i) => sum + i.cents, 0);\n }" }],
  rules: [], mode: "standard",
};
const outside: Candidate = {
  title: "Charges are 100 times too large", description: "total() now returns cents, but charge() still converts dollars to cents. Every payment is overcharged.",
  severity: "critical", confidence: 0.97, category: "correctness", filePath: "payments.ts", startLine: 2, endLine: 2,
  evidence: [
    { filePath: "payments.ts", startLine: 2, quote: "export function charge(items) { return gateway.charge(total(items) * 100); }" },
    { filePath: "cart.ts", startLine: 2, quote: "  return items.reduce((sum, i) => sum + i.cents, 0);" },
  ],
  impact: "Customers are charged 100 times the price.", suggestedFix: "Pass total(items) to the gateway without multiplying.", symbol: "charge",
  suggestion: { startLine: 2, endLine: 2, original: "export function charge(items) { return gateway.charge(total(items) * 100); }", replacement: "export function charge(items) { return gateway.charge(total(items)); }" },
};

test("verdict mapping covers every severity, score boundary and incomplete coverage", () => {
  const f = (...severities: Finding["severity"][]) => severities.map((severity) => ({ severity }));
  const cases: [Parameters<typeof reviewVerdict>[0], string][] = [
    [{ score: 5, findings: f("critical") }, "changes"],
    [{ score: 5, findings: f("high") }, "changes"],
    [{ score: 5, findings: f("medium") }, "fixes"],
    [{ score: 5, findings: f("low") }, "ready"],
    [{ score: 4, findings: f("low", "low") }, "ready"],
    [{ score: 5, findings: [] }, "ready"],
    [{ score: 4, findings: [] }, "ready"],
    [{ score: 3, findings: [] }, "fixes"],
    [{ score: 2, findings: [] }, "changes"],
    [{ score: 1, findings: [] }, "changes"],
    [{ score: 0, findings: [] }, "changes"],
    [{ score: 3, findings: f("low") }, "fixes"],
    [{ score: 2, findings: f("medium") }, "changes"],
    // Incomplete coverage only prevents "ready"; verified problems still decide the verdict.
    [{ score: 5, findings: [], incomplete: true }, "incomplete"],
    [{ score: 4, findings: f("low"), incomplete: true }, "incomplete"],
    [{ score: 5, findings: f("medium"), incomplete: true }, "fixes"],
    [{ score: 5, findings: f("critical"), incomplete: true }, "changes"],
    [{ score: 3, findings: [], incomplete: true }, "fixes"],
    // Without a recorded score, nothing can be called ready.
    [{ findings: [] }, "incomplete"],
    [{ findings: f("low") }, "incomplete"],
    [{ findings: f("high") }, "changes"],
    [{ findings: f("medium") }, "fixes"],
  ];
  for (const [args, expected] of cases) assert.equal(reviewVerdict(args), expected, JSON.stringify(args));
  assert.deepEqual(Object.values(verdictLabels), ["Ready to merge", "Merge after fixes", "Needs changes", "Review incomplete"]);
  assert.equal(verdictLine("fixes", { value: 3 }), "**Merge after fixes** · Confidence score **3/5**");
  assert.equal(verdictLine("incomplete"), "**Review incomplete**");
});

test("outside-diff grounding needs an exact quote of a changed line; changed-line anchors stay inline", () => {
  assert.equal(grounded(outside, input), false, "never an inline anchor");
  assert.equal(groundedOutside(outside, input), true);
  // No evidence on a changed line: rejected.
  assert.equal(groundedOutside({ ...outside, evidence: [outside.evidence[0]] }, input), false);
  // Evidence cites cart.ts but an unchanged line of it: rejected.
  assert.equal(groundedOutside({ ...outside, evidence: [outside.evidence[0], { filePath: "cart.ts", startLine: 1, quote: "export function total(items) {" }] }, input), false);
  // Every quote must still match the source exactly.
  assert.equal(groundedOutside({ ...outside, evidence: [{ ...outside.evidence[0], quote: "export function charge(items) {}" }, outside.evidence[1]] }, input), false);
  assert.equal(groundedOutside({ ...outside, evidence: [outside.evidence[0], { ...outside.evidence[1], startLine: 3 }] }, input), false);
  // Anchors beyond the file, oversized ranges and external context files are rejected.
  assert.equal(groundedOutside({ ...outside, startLine: 9, endLine: 9 }, input), false);
  assert.equal(groundedOutside({ ...outside, startLine: 1, endLine: 30 }, input), false);
  const external = { ...input, files: [...input.files, { path: "context/other/pay.ts", sha: "3", content: payments, provenance: { repository: "acme/other", revision: "r", sourceUrl: "https://example.com/pay.ts" } }] };
  assert.equal(groundedOutside({ ...outside, filePath: "context/other/pay.ts" }, external), false);
  // A changed line is grounded()'s business, not an outside finding.
  const onChanged = { ...outside, filePath: "cart.ts", startLine: 2, endLine: 2, suggestion: undefined };
  assert.equal(groundedOutside(onChanged, input), false);
  assert.equal(grounded(onChanged, input), true);
  // Incremental reviews: the causing line must be changed by this increment and by the pull request.
  const increment = { ...input, diff: [{ path: "cart.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function total(items) {\n-  return items.reduce((sum, i) => sum + i.price, 0);\n+  return items.reduce((sum, i) => sum + i.cents, 0);\n }" }], fullDiff: [{ path: "cart.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export function total(items) {\n   return items.reduce((sum, i) => sum + i.cents, 0);\n-}\n+}\n" }] };
  assert.equal(groundedOutside(outside, increment), false);
});

class OutsideModel implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private candidates: Candidate[]) {}
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    this.requests.push(request);
    const value = request.task === "review:correctness" ? { findings: this.candidates }
      : request.task.startsWith("review:") ? { findings: [] }
      : request.task === "verify" ? { decisions: (request.input as { candidates: unknown[] }).candidates.map((_, index) => ({ index, publish: true, reason: "charge() multiplies the cents total returned by the changed total().", confidence: 0.96 })) }
      : request.task === "diagram" ? { diagram: null }
      : { reviewScore: { value: 1, reason: "Payments are overcharged a hundredfold by an untouched caller." }, summary: "Cart totals are now computed in integer cents instead of dollars." };
    return { value: schema.parse(value), usage: { task: request.task, provider: "fixture", model: "deterministic", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  }
}

test("the engine keeps a verified outside-diff finding, flags it, drops its suggestion and renders it in the summary", async () => {
  const model = new OutsideModel([outside, { ...outside, title: "Unsupported claim about payments", evidence: [outside.evidence[0]] }]);
  const result = await reviewChange(input, model);
  assert.equal(result.findings.length, 1);
  const [f] = result.findings;
  assert.equal(f.outsideDiff, true);
  assert.equal(f.filePath, "payments.ts");
  assert.equal(f.suggestion, undefined, "a suggestion cannot be committed on an unchanged line");
  assert.ok(result.metadata.suppressions?.some((s) => s.title === "Unsupported claim about payments" && /does not match source/.test(s.reason)));
  assert.equal(result.metadata.verdict, "changes");
  assert.equal(result.metadata.coverageIncomplete, false);
  assert.deepEqual(inlineFindings(result.findings), []);
  assert.match(result.summary, /^\*\*Needs changes\*\* · Confidence score \*\*1\/5\*\*\n\n### Overview/);
  assert.match(result.summary, /### Issues\nNo verified findings on the changed lines; see Outside the changed code\.\n\n### Outside the changed code\n/);
  assert.match(result.summary, /- 🔴 \*\*P0\*\* · critical · `payments\.ts:2` · Charges are 100 times too large\n  Caused by `cart\.ts:2`\. total\(\) now returns cents, but charge\(\) still converts dollars to cents\. \*\*Fix:\*\* Pass total\(items\) to the gateway without multiplying\./);
  // Specialists are told how to anchor these.
  assert.match(model.requests.find((r) => r.task === "review:correctness")!.system, /anchor on that unchanged line and include at least one evidence quote of the changed line/);
});

test("summary: the outside section follows Issues, shows even when Issues is off, and never duplicates into the table", () => {
  const head = "a".repeat(40);
  const make = (c: Candidate, extra: Partial<Finding> = {}): Finding => ({ ...c, fingerprint: c.title.slice(0, 8), agent: "correctness", commitSha: head, ...extra });
  const inline = make({ ...outside, title: "Totals overflow", severity: "medium", filePath: "cart.ts", startLine: 2, endLine: 2, suggestion: undefined });
  const away = make(outside, { outsideDiff: true });
  const data = { overview: "Cents everywhere.", files: input.diff, findings: [inline, away], resolved: [], score: { value: 1, reason: "Overcharges every payment." }, assessment: undefined, runtimeEvidence: undefined, coverageLimits: [], contextCount: 2, candidates: 2, suppressed: 0 };
  const full = reviewSummary(data);
  const sections = full.split("\n\n### ").map((s) => s.split("\n")[0]);
  assert.deepEqual(sections.slice(0, 5), ["**Needs changes** · Confidence score **1/5**", "Overview", "Files changed", "Issues", "Outside the changed code"]);
  const table = full.split("### Issues\n")[1].split("\n\n")[0];
  assert.match(table, /Totals overflow/);
  assert.doesNotMatch(table, /Charges are 100 times too large/);
  assert.match(full, /### Coverage\n1 changed files; 2 retrieved context files\. 2 candidates; 2 verified findings; 0 suppressed\./);
  const noIssues = reviewSummary(data, ["overview", "risk"]);
  assert.match(noIssues, /^\*\*Needs changes\*\*\n\n### Overview\nCents everywhere\.\n\n### Outside the changed code\n/);
  assert.match(reviewSummary(data, []), /^\*\*Needs changes\*\*\n\n### Outside the changed code\n/);
  // Without outside findings nothing changes from before.
  assert.doesNotMatch(reviewSummary({ ...data, findings: [inline] }), /Outside the changed code/);
  // Bounded: at most 20 listed.
  const many = reviewSummary({ ...data, findings: Array.from({ length: 23 }, (_, i) => make({ ...outside, title: "Outside finding " + i }, { outsideDiff: true, fingerprint: "f" + i })) }, []);
  assert.equal((many.match(/^- 🔴 \*\*P0\*\* · critical/gm) ?? []).length, 20);
  assert.match(many, /- 3 more on the review page\./);
  // Incomplete coverage turns a clean review into "Review incomplete".
  assert.match(reviewSummary({ ...data, findings: [], score: { value: 5, reason: "No defects were found in the reviewed files." }, incomplete: true }), /^\*\*Review incomplete\*\* · Confidence score \*\*5\/5\*\*/);
  assert.match(reviewSummary({ ...data, findings: [], score: { value: 5, reason: "No defects were found in the reviewed files." } }), /^\*\*Ready to merge\*\* · Confidence score \*\*5\/5\*\*/);
});

test("GitHub never posts outside-diff findings inline; the summary carrying them is edited in place without duplicates", async (t) => {
  t.mock.method(console, "log", () => {});
  const head = "a".repeat(40);
  const issueComments: { id: number; body: string; user: { login: string } }[] = [];
  const reviews: { id: number; body: string; commit_id: string; state: string; user: { login: string } }[] = [];
  const prComments: { pull_request_review_id: number }[] = [];
  let reviewPosts = 0, summaryPosts = 0, summaryEdits = 0, posted: { comments: { body: string; path: string }[] } | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === "/repos/o/r/pulls/1") return Response.json({ state: "open", head: { sha: head } });
    if (path.endsWith("/files")) return Response.json([{ filename: "cart.ts", patch: input.diff[0].patch }]);
    if (path === "/repos/o/r/issues/1/comments" && options.method === "POST") { summaryPosts++; const c = { id: 100 + summaryPosts, body: JSON.parse(String(options.body)).body, user: { login: "openreview[bot]" } }; issueComments.push(c); return Response.json(c); }
    if (path === "/repos/o/r/issues/1/comments") return Response.json(issueComments);
    if (/^\/repos\/o\/r\/issues\/comments\/\d+$/.test(path) && options.method === "PATCH") { summaryEdits++; const c = issueComments.find((c) => path.endsWith("/" + c.id))!; c.body = JSON.parse(String(options.body)).body; return Response.json(c); }
    if (path.endsWith("/reviews") && options.method === "POST") { reviewPosts++; posted = JSON.parse(String(options.body)); const r = { id: 200 + reviewPosts, body: JSON.parse(String(options.body)).body, commit_id: head, state: "COMMENTED", user: { login: "openreview[bot]" } }; reviews.push(r); prComments.push(...posted!.comments.map((c, i) => ({ id: 300 + i, body: c.body, user: { login: "openreview[bot]" }, path: c.path, line: 2, position: 5, commit_id: head, pull_request_review_id: r.id }))); return Response.json(r); }
    if (path.endsWith("/reviews")) return Response.json(reviews);
    // GitHub's pull request comment list carries line numbers; its per-review list only has the diff position.
    if (path === "/repos/o/r/pulls/1/comments") return Response.json(prComments);
    if (/\/reviews\/\d+\/comments$/.test(path)) return Response.json(prComments.filter((c) => c.pull_request_review_id === Number(path.split("/").at(-2))).map((c) => ({ ...c, line: undefined })));
    throw new Error("Unexpected endpoint " + path);
  });
  const github = new Github("fixture", undefined, async () => "openreview");
  const inline: Finding = { ...outside, title: "Totals overflow", filePath: "cart.ts", suggestion: undefined, fingerprint: "1".repeat(64), agent: "correctness", commitSha: head };
  const away: Finding = { ...outside, suggestion: undefined, fingerprint: "2".repeat(64), agent: "correctness", commitSha: head, outsideDiff: true };
  const summary = "Summary\n\n### Outside the changed code\n- **critical** · `payments.ts:2` · Charges are 100 times too large";
  const first = await github.publish("o/r", 1, head, summary, [inline, away], "run-1");
  assert.equal(posted!.comments.length, 1);
  assert.equal(posted!.comments[0].path, "cart.ts");
  assert.ok(posted!.comments.every((c) => !c.body.includes("2".repeat(64))));
  assert.deepEqual(first.comments?.map((c) => c.fingerprint), ["1".repeat(64)]);
  assert.match(issueComments[0].body, /### Outside the changed code/);
  // Only outside findings: no inline review at all, just the summary.
  const onlyOutside = await github.publish("o/r", 1, head, summary + " (run two)", [away], "run-2");
  assert.deepEqual([reviewPosts, summaryPosts, summaryEdits], [1, 1, 1]);
  assert.deepEqual(onlyOutside.comments, []);
  // Retrying the first run republishes nothing; the one summary comment keeps being edited.
  assert.equal((await github.publish("o/r", 1, head, summary, [inline, away], "run-1")).reused, true);
  assert.deepEqual([reviewPosts, summaryPosts], [1, 1]);
  assert.equal(issueComments.length, 1);
  assert.equal((issueComments[0].body.match(/### Outside the changed code/g) ?? []).length, 1);
});
