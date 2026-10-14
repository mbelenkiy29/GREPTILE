import { test } from "node:test";
import assert from "node:assert/strict";
import { pullRequestTrigger, sizeLimitIssue, effectiveThresholds } from "../src/triggers";
import { scopeDefaults } from "../src/review-settings";

const base = { automatic: true, drafts: false, rereview: true, targetBranches: [] as string[], ignoredBranches: [] as string[], triggerLabels: [] as string[], excludedAuthors: [] as string[] };
const pr = (extra: Record<string, unknown> = {}) => ({ draft: false, base: { ref: "main" }, head: { ref: "feature" }, user: { login: "alice" }, labels: [] as { name: string }[], ...extra });
const decide = (action: string, settings = base, p = pr(), label?: string) => pullRequestTrigger({ action, pr: p, label }, settings);

test("automatic triggers follow opened/reopened/ready/synchronize and the rereview setting", () => {
  for (const action of ["opened", "reopened", "ready_for_review", "synchronize"]) assert.deepEqual(decide(action), { review: true, trigger: "automatic" });
  assert.equal(decide("synchronize", { ...base, rereview: false }).review, false);
  assert.equal(decide("closed").review, false);
  assert.equal(decide("labeled").review, false, "labels only trigger when configured");
});

test("only-on-mention mode: automatic off means no webhook-triggered reviews without a trigger label", () => {
  const mention = { ...base, automatic: false };
  for (const action of ["opened", "synchronize", "reopened"]) assert.deepEqual(decide(action, mention), { review: false, reason: "Automatic reviews are off" });
});

test("trigger labels start reviews on labeled and keep re-reviewing labelled PRs, case-insensitively", () => {
  const labelled = { ...base, automatic: false, triggerLabels: ["Needs-Review"] };
  assert.deepEqual(decide("labeled", labelled, pr(), "needs-review"), { review: true, trigger: "label" });
  assert.equal(decide("labeled", labelled, pr(), "bug").review, false);
  assert.deepEqual(decide("synchronize", labelled, pr({ labels: [{ name: "needs-review" }] })), { review: true, trigger: "label" });
  assert.deepEqual(decide("opened", labelled, pr({ labels: [{ name: "NEEDS-REVIEW" }] })), { review: true, trigger: "label" });
  assert.equal(decide("synchronize", { ...labelled, rereview: false }, pr({ labels: [{ name: "needs-review" }] })).review, false);
});

test("excluded author globs, branch filters and drafts block both automatic and label triggers", () => {
  const filtered = { ...base, triggerLabels: ["review"], excludedAuthors: ["dependabot[bot]", "*-bot"] };
  assert.match((decide("opened", filtered, pr({ user: { login: "dependabot[bot]" } })) as { reason: string }).reason, /excluded/);
  assert.equal(decide("labeled", filtered, pr({ user: { login: "release-bot" } }), "review").review, false);
  assert.equal(decide("opened", filtered, pr({ user: { login: "Release-BOT" } })).review, false, "globs are case-insensitive");
  assert.equal(decide("opened", filtered).review, true);
  assert.equal(decide("opened", { ...base, targetBranches: ["release/*"] }).review, false);
  assert.equal(decide("opened", { ...base, ignoredBranches: ["feature"] }).review, false);
  assert.equal(decide("opened", base, pr({ draft: true })).review, false);
  assert.equal(decide("opened", { ...base, drafts: true }, pr({ draft: true })).review, true);
});

test("size limits skip oversized automatic reviews with an actionable reason", () => {
  const diff = [{ path: "a.ts", status: "modified", patch: "@@ -1,2 +1,3 @@\n x\n-y\n+z\n+w" }, { path: "b.ts", status: "added", patch: "@@ -0,0 +1 @@\n+b" }];
  assert.equal(sizeLimitIssue(diff, {}), undefined);
  assert.equal(sizeLimitIssue(diff, { maxFiles: 2, maxChangedLines: 4 }), undefined);
  assert.match(sizeLimitIssue(diff, { maxFiles: 1 })!, /2 changed files exceed the configured limit of 1.*@openreview review/);
  assert.match(sizeLimitIssue(diff, { maxChangedLines: 3 })!, /4 changed lines exceed the configured limit of 3/);
});

test("strictness presets map to confidence and severity thresholds; 0 keeps custom values", () => {
  const custom = { minimumConfidence: 0.9, severityThreshold: "critical" };
  assert.deepEqual(effectiveThresholds({ ...custom, strictness: 0 }), custom);
  assert.deepEqual(effectiveThresholds({ ...custom }), custom);
  assert.deepEqual(effectiveThresholds({ ...custom, strictness: 1 }), { minimumConfidence: 0.95, severityThreshold: "high" });
  assert.deepEqual(effectiveThresholds({ ...custom, strictness: 2 }), { minimumConfidence: 0.85, severityThreshold: "medium" });
  assert.deepEqual(effectiveThresholds({ ...custom, strictness: 3 }), { minimumConfidence: 0.75, severityThreshold: "low" });
});

test("trigger settings inherit workspace → team and only explicitly overridden keys apply", () => {
  const scopes = [
    { settings: { triggerLabels: ["review"], excludedAuthors: ["*[bot]"], strictness: 3 }, overrideKeys: ["triggerLabels", "excludedAuthors"] },
    { teamId: "t1", settings: { triggerLabels: ["team-review"], maxFiles: 50 }, overrideKeys: ["triggerLabels", "maxFiles"] },
  ];
  const team = scopeDefaults(scopes, "t1");
  assert.deepEqual([team.triggerLabels, team.excludedAuthors, team.maxFiles, team.strictness], [["team-review"], ["*[bot]"], 50, 0]);
  const workspace = scopeDefaults(scopes);
  assert.deepEqual([workspace.triggerLabels, workspace.maxFiles], [["review"], 0]);
});
