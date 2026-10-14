import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { Github } from "../src/github";
import { reviewChange, reviewFileLimits } from "../src/engine/review";
import { riskScore } from "../src/engine/classify";
import { ModelFailure } from "../src/engine/model";
import type { ChangedFile, ModelProvider, ModelRequest, ReviewInput } from "../src/engine/types";

const quiet = (t: { mock: { method: (o: object, m: string, f: () => void) => void } }) => t.mock.method(console, "log", () => {});
const usage = (task: string) => ({ task, provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 1, latencyMs: 0, estimatedCost: 0, cached: false });
class Fixture implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private fail: (task: string) => boolean = () => false) {}
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    this.requests.push(request);
    if (this.fail(request.task)) throw new ModelFailure("provider unavailable", usage(request.task));
    const value = request.task.startsWith("review:") ? { findings: [] } : request.task === "verify" ? { decisions: [] } : request.task === "resolution" ? { resolved: [] } : { summary: "The change was reviewed within the available budget.", reviewScore: { value: 5, reason: "No verified findings within the reviewed files; coverage is limited." } };
    return { value: schema.parse(value), usage: usage(request.task) };
  }
}
const base: Omit<ReviewInput, "diff" | "files"> = { repository: "acme/app", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "Large change", description: "", rules: [], mode: "standard" };

test("truncated GitHub trees fall back to bounded subtree traversal", async t => {
  quiet(t);
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    seen.push(path);
    const tree = (truncated: boolean, tree: object[]) => Response.json({ truncated, tree });
    if (path === "/repos/acme/app/git/trees/root?recursive=1") return tree(true, [{ path: "partial.ts", type: "blob", sha: "p" }]);
    if (path === "/repos/acme/app/git/trees/root") return tree(false, [{ path: "README.md", type: "blob", sha: "r", size: 10 }, { path: "src", type: "tree", sha: "src" }, { path: "big", type: "tree", sha: "big" }, { path: "mod", type: "commit", sha: "c" }]);
    if (path === "/repos/acme/app/git/trees/src?recursive=1") return tree(false, [{ path: "a.ts", type: "blob", sha: "a" }, { path: "lib", type: "tree", sha: "lib" }, { path: "lib/b.ts", type: "blob", sha: "b" }]);
    if (path === "/repos/acme/app/git/trees/big?recursive=1") return tree(true, []);
    if (path === "/repos/acme/app/git/trees/big") return tree(false, [{ path: "c.ts", type: "blob", sha: "c1" }, { path: "deep", type: "tree", sha: "deep" }]);
    if (path === "/repos/acme/app/git/trees/deep?recursive=1") return tree(false, [{ path: "d.ts", type: "blob", sha: "d" }]);
    return new Response("not found", { status: 404 });
  });
  const files = await new Github("fixture").tree("acme/app", "root");
  assert.deepEqual(files.map(f => f.path).sort(), ["README.md", "big/c.ts", "big/deep/d.ts", "src/a.ts", "src/lib/b.ts"]);
  assert.ok(files.every(f => f.type === "blob"));
  assert.ok(!seen.some(p => p.includes("/trees/c?")), "submodule commits are not traversed");
});

test("untruncated trees keep the single recursive request", async t => {
  quiet(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ truncated: false, tree: [{ path: "a.ts", type: "blob", sha: "a" }, { path: "src", type: "tree", sha: "s" }] }); });
  assert.deepEqual((await new Github("fixture").tree("acme/app", "root")).map(f => f.path), ["a.ts"]);
  assert.equal(calls, 1);
});

test("GitHub pull requests with omitted diffs degrade to skipped files instead of failing", async t => {
  quiet(t);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/repos/acme/app/pulls/7") return Response.json({ number: 7, title: "Big", body: null, draft: false, state: "open", html_url: "https://github.com/acme/app/pull/7", user: { id: 1, login: "dev" }, head: { sha: "h".repeat(40), ref: "f" }, base: { sha: "b".repeat(40), ref: "main" }, changed_files: 3005 });
    if (path === "/repos/acme/app/pulls/7/files") return Response.json(new URL(url).searchParams.get("page") === "1" ? [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", changes: 2 }, { filename: "data/huge.json", status: "modified", changes: 90000 }, { filename: "logo.png", status: "added", changes: 1 }] : []);
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
    return Response.json([]);
  });
  const pr = await new Github("fixture").pullRequest("acme/app", 7);
  assert.equal(pr.diff.length, 3);
  assert.deepEqual(pr.omitted, [{ path: "data/huge.json", reason: "GitHub omitted the text diff (too large to display)" }, { path: "(3002 more files)", reason: "GitHub lists at most 3,000 changed files per pull request" }]);
});

test("a 600-file change reviews the riskiest files within the mode limit and reports the rest", async () => {
  const diff: ChangedFile[] = Array.from({ length: 600 }, (_, i) => ({ path: i === 599 ? "src/auth/session.ts" : `docs/page-${i}.md`, status: "modified", patch: `@@ -1 +1 @@\n-old ${i}\n+new ${i}` }));
  const model = new Fixture();
  const result = await reviewChange({ ...base, diff, files: [{ path: "src/auth/session.ts", sha: "s", content: "new 599" }], skippedFiles: [{ path: "data/huge.json", reason: "GitHub omitted the text diff (too large to display)" }] }, model);
  const reviewed = (model.requests.find(r => r.task === "review:security")!.context as { diff: { path: string }[] }).diff;
  assert.equal(reviewed.length, reviewFileLimits.standard);
  assert.equal(reviewed[0].path === "src/auth/session.ts" || reviewed.some(f => f.path === "src/auth/session.ts"), true);
  const skipped = result.metadata.skippedFiles!;
  assert.equal(skipped.length, 600 - reviewFileLimits.standard + 1);
  assert.ok(skipped.some(f => f.path === "data/huge.json"));
  assert.ok(skipped.filter(f => f.reason.includes("review limit of 350 files")).every(f => f.path.startsWith("docs/")));
  assert.ok(result.metadata.coverageLimits!.some(l => l.includes("251 changed files were not reviewed")));
  assert.match(result.summary, /Skipped files:\n- `/);
  assert.match(result.summary, /more skipped files omitted from this summary/);
  assert.ok(riskScore(diff[599]) > riskScore(diff[0]));
});

test("payloads over the context budget drop the lowest-risk patches instead of failing", async () => {
  const big = "+" + "x".repeat(120_000);
  const diff: ChangedFile[] = [
    { path: "README.md", status: "modified", patch: "@@ -1 +1 @@\n" + big },
    { path: "src/db/migration.sql", status: "modified", patch: "@@ -1 +1 @@\n+DELETE FROM users;" + big },
    { path: "dist/bundle.min.js", status: "modified", patch: "@@ -1 +1 @@\n" + big },
  ];
  const model = new Fixture();
  const result = await reviewChange({ ...base, diff, files: [] }, model);
  const reviewed = (model.requests.find(r => r.task === "review:data")!.context as { diff: { path: string }[] }).diff.map(f => f.path);
  // 360 KB of patches against a 300 KB budget: only the generated bundle (lowest risk) must go.
  assert.deepEqual(reviewed, ["README.md", "src/db/migration.sql"]);
  assert.deepEqual(result.metadata.skippedFiles!.map(f => f.path), ["dist/bundle.min.js"]);
  assert.ok(result.metadata.skippedFiles!.every(f => f.reason === "Lower-risk file dropped to fit the review context budget"));
  assert.ok(JSON.stringify(model.requests[0].context).length <= 300_000);
});

test("one failing specialist yields a partial review with a visible note; all failing fails the review", async () => {
  const diff: ChangedFile[] = [{ path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }];
  const files = [{ path: "src/a.ts", sha: "a", content: "b" }];
  const partial = new Fixture(task => task === "review:security");
  const result = await reviewChange({ ...base, diff, files }, partial);
  assert.deepEqual(result.metadata.failedSpecialists, [{ category: "security", error: "provider unavailable" }]);
  assert.ok(result.metadata.coverageLimits!.some(l => l.includes("specialists failed") && l.includes("security")));
  assert.ok(result.usage.some(u => u.task === "review:security"), "failed calls keep their billed usage");
  assert.ok(partial.requests.some(r => r.task === "summary"));
  await assert.rejects(reviewChange({ ...base, diff, files }, new Fixture(task => task.startsWith("review:"))), /Every review specialist failed/);
  const controller = new AbortController();
  const cancelling: ModelProvider = { async generate(request) { controller.abort(); throw new Error("aborted " + request.task); } };
  await assert.rejects(reviewChange({ ...base, diff, files }, cancelling, async () => {}, controller.signal), /aborted|AbortError|This operation was aborted/);
});

test("ignored paths are reported as skipped and cannot anchor findings", async () => {
  const diff: ChangedFile[] = [{ path: "gen/out.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }, { path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }];
  const model = new Fixture();
  const result = await reviewChange({ ...base, diff, files: [{ path: "src/a.ts", sha: "a", content: "b" }, { path: "gen/out.ts", sha: "g", content: "b" }], settings: { ignoredPaths: ["gen/**"] } }, model);
  assert.deepEqual(result.metadata.skippedFiles, [{ path: "gen/out.ts", reason: "Excluded by the ignored paths setting" }]);
  assert.ok(result.metadata.coverageLimits!.includes("Configured paths were excluded"));
  assert.ok(!result.metadata.coverageLimits!.some(l => l.includes("were not reviewed")));
});
