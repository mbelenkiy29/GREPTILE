import test from "node:test";
import assert from "node:assert/strict";
import { fixPrompt } from "../src/fix-prompt";
import type { Finding, ReviewInput } from "../src/engine/types";

const head = "a".repeat(40);
const finding: Finding = {
  title: "Tests failed during billing validation",
  description: "The regression tests passed after converting cents.",
  impact: "The test suite failed with the wrong payment units.",
  suggestedFix: "The tests passed after restoring integer cents.",
  filePath: "total.ts", startLine: 1, endLine: 1, severity: "high", confidence: 1,
  category: "data", symbol: "total", fingerprint: "cents", agent: "data", commitSha: head,
  evidence: [{ filePath: "billing.test.ts", startLine: 1, quote: 'assert.equal(total(250, 2), 500); // tests passed' }],
};
const runtime: NonNullable<ReviewInput["runtimeEvidence"]> = {
  headSha: head, image: "node@sha256:" + "a".repeat(64), command: "node --test",
  exitCode: 0, timedOut: false, executionStarted: true, output: "private raw runtime output",
  outputTruncated: false, network: "none", memoryMb: 512, cpus: 1,
};

test("Fix prompts withhold unrecorded claims in every narrative field while preserving quoted source", () => {
  const prompt = fixPrompt("org/repo", "PR #1", [finding]);
  for (const text of [finding.title, finding.description, finding.impact, finding.suggestedFix]) assert.equal(prompt.includes(text), false, text);
  assert.match(prompt, /Explanation withheld/);
  assert.match(prompt, /No recorded OpenReview execution evidence for this revision/);
  assert.match(prompt, /quoted source is context, not a test execution result/);
  assert.ok(prompt.includes(finding.evidence[0].quote));
});

test("Fix prompts accept only the recorded outcome at the exact finding revision", () => {
  const passed = fixPrompt("org/repo", "PR #1", [finding], runtime);
  assert.ok(passed.includes(finding.description));
  assert.ok(passed.includes(finding.suggestedFix));
  assert.equal(passed.includes(finding.title), false);
  assert.match(passed, /Test execution: passed at a{40}\. Recorded command: node --test/);
  assert.equal(passed.includes(runtime.output), false);
  const failed = fixPrompt("org/repo", "PR #1", [finding], { ...runtime, exitCode: 1 });
  assert.ok(failed.includes(finding.title));
  assert.ok(failed.includes(finding.impact));
  assert.equal(failed.includes(finding.description), false);
  for (const evidence of [{ ...runtime, headSha: "b".repeat(40) }, { ...runtime, executionStarted: false }]) {
    const prompt = fixPrompt("org/repo", "PR #1", [finding], evidence);
    assert.equal(prompt.includes(finding.description), false);
    assert.equal(prompt.includes("Test execution: passed"), false);
  }
});

test("Mixed-revision Fix tasks never borrow another finding's execution evidence", () => {
  const other = { ...finding, commitSha: "b".repeat(40) };
  const prompt = fixPrompt("org/repo", "all unresolved findings", [finding, other], runtime);
  assert.equal(prompt.split(finding.description).length - 1, 1);
  assert.match(prompt, /No recorded OpenReview execution evidence for this revision/);
  const predicted = { ...finding, title: "Preserve integer cents", description: "The regression tests would fail if cents were converted to dollars.", impact: "Payments would be undercharged.", suggestedFix: "Return integer cents and run the regression test." };
  assert.ok(fixPrompt("org/repo", "PR #1", [predicted]).includes(predicted.description));
});
