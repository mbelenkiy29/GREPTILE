import { test } from "node:test";
import assert from "node:assert/strict";
import { addressedFindings, commitPreference, ignoredAtMerge, touchedOldLines } from "../src/commit-signals";
import { preferenceProblem } from "../src/conventions";
import type { Comparison } from "../src/incremental";

const finding = (fingerprint: string, filePath: string, startLine: number, endLine = startLine) => ({ fingerprint, filePath, startLine, endLine });
const ahead = (files: Comparison["files"]): Comparison => ({ status: "ahead", commits: 1, complete: true, files });
// pay.ts: line 10 is rewritten; 40 is untouched.
const payPatch = "@@ -8,5 +8,5 @@\n a\n b\n-  return cents / 100;\n+  return cents;\n c\n d";

test("touched old lines: removals and the lines around insertions", () => {
  assert.deepEqual([...touchedOldLines(payPatch)].sort((a, b) => a - b), [10, 11]);
  assert.deepEqual([...touchedOldLines("@@ -4,2 +4,3 @@\n a\n+inserted\n b")].sort((a, b) => a - b), [4, 5]);
  assert.deepEqual([...touchedOldLines("@@ -1,0 +1,1 @@\n+first line\n\\ No newline at end of file")].sort((a, b) => a - b), [0, 1]);
});

test("addressed: verified fixes whose lines a later commit changed; everything else stays unattributed", () => {
  const previous = [finding("near", "pay.ts", 10), finding("window", "pay.ts", 12, 13), finding("far", "pay.ts", 40), finding("other", "ui.ts", 3), finding("open", "pay.ts", 10), finding("gone", "old.ts", 5), finding("moved", "src/legacy.ts", 7)];
  const comparison = ahead([
    { path: "pay.ts", status: "modified", patch: payPatch },
    { path: "old.ts", status: "removed", patch: "" },
    { path: "src/core.ts", previousPath: "src/legacy.ts", status: "renamed", patch: "@@ -6,3 +6,3 @@\n a\n-b\n+c\n d" },
  ]);
  const result = addressedFindings(previous, ["near", "window", "far", "other", "gone", "moved"], comparison);
  assert.deepEqual(result.addressed, ["near", "window", "gone", "moved"]);
  assert.deepEqual(result.unattributed, [{ fingerprint: "far", reason: "resolved without a commit changing the flagged lines" }, { fingerprint: "other", reason: "resolved without a commit changing the flagged lines" }]);
  assert.equal(result.addressed.includes("open"), false, "unresolved findings never count");
});

test("force-pushes, rebases and unusable comparisons attribute nothing", () => {
  const previous = [finding("a", "pay.ts", 10)];
  const reasons = (c: Parameters<typeof addressedFindings>[2]) => { const r = addressedFindings(previous, ["a"], c); assert.deepEqual(r.addressed, []); return r.unattributed[0].reason; };
  assert.equal(reasons({ status: "diverged", commits: 2, complete: true, files: [{ path: "pay.ts", status: "modified", patch: payPatch }] }), "the branch was force-pushed or rebased");
  assert.equal(reasons({ status: "behind", commits: 0, complete: true, files: [] }), "the branch was force-pushed or rebased");
  assert.equal(reasons("unavailable"), "the last reviewed commit could not be compared");
  assert.equal(reasons(undefined), "the last reviewed commit could not be compared");
  assert.equal(reasons({ status: "ahead", commits: 300, complete: false, files: [{ path: "pay.ts", status: "modified", patch: payPatch }] }), "the comparison was incomplete");
  assert.equal(reasons({ status: "identical", commits: 0, complete: true, files: [] }), "there were no new commits");
});

test("ignored at merge: open findings without feedback, only when the last review covered the merged head", () => {
  const findings = [{ id: "open", status: "open" }, { id: "fixed", status: "resolved" }, { id: "waived", status: "wont_fix", lastFeedback: "wont_fix" }, { id: "liked", status: "open", lastFeedback: "useful" }, { id: "false", status: "false_positive", lastFeedback: "false_positive" }];
  assert.deepEqual(ignoredAtMerge(findings, "h1", "h1").ignored.map((f) => f.id), ["open"]);
  assert.deepEqual(ignoredAtMerge(findings, "h1", "h2"), { ignored: [], reason: "commits after the last review were merged unreviewed" });
  assert.deepEqual(ignoredAtMerge(findings, "h1", undefined), { ignored: [], reason: "commits after the last review were merged unreviewed" });
  assert.deepEqual(ignoredAtMerge(findings, undefined, "h1"), { ignored: [], reason: "the pull request was never reviewed" });
});

test("learner bounds: enough signals and a clear majority; ignored findings ask for stronger evidence, never for security", () => {
  assert.equal(commitPreference("correctness", { addressed: 3, ignored: 1 }), null, "below the minimum");
  assert.equal(commitPreference("correctness", { addressed: 3, ignored: 3 }), null, "no clear majority");
  const fixed = commitPreference("performance", { addressed: 6, ignored: 1 })!;
  assert.match(fixed, /^Authors fixed 6 of the last 7 performance findings/);
  const ignored = commitPreference("performance", { addressed: 1, ignored: 6 })!;
  assert.match(ignored, /^Authors merged 6 of the last 7 performance findings .* report performance issues only when the evidence shows a concrete defect/);
  for (const text of [fixed, ignored]) assert.equal(preferenceProblem(text, "performance"), null);
  assert.doesNotMatch(ignored, /\b(do not|don't|never|stop|skip|suppress|ignore)\b/i, "narrowing never asks for silence");
  // Security: fixes reinforce, ignored findings never narrow.
  assert.equal(commitPreference("security", { addressed: 0, ignored: 50 }), null);
  assert.match(commitPreference("security", { addressed: 7, ignored: 0 })!, /^Authors fixed 7 of the last 7 security findings/);
  assert.equal(commitPreference("rules", { addressed: 0, ignored: 5 })?.includes("custom-rule findings"), true);
});
