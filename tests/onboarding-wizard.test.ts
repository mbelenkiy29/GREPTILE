import test from "node:test";
import assert from "node:assert/strict";
import { configureSteps, needsSetup, nextStep, previousStep, resolveStep, stepKeys, stepSettingsFromForm, wizardSteps } from "../src/onboarding-steps";
import { previewComments, pullRequestOutcome, pullRequestSteps, sampleFindings, triggerTimeline } from "../src/onboarding-preview";
import { graphLayout, litCount } from "../src/onboarding-graph";
import { installHref, installReturnPath } from "../src/github-install";
import { pullRequestTrigger } from "../src/triggers";
import { defaults } from "../src/review-settings";

const ready = { hasWorkspace: true, connected: true, selected: 2, indexingStarted: true, completed: false };

test("setup resumes at the first step still needed and guards later steps", () => {
  assert.equal(resolveStep(undefined, { ...ready, hasWorkspace: false }), "workspace");
  assert.equal(resolveStep("tools", { ...ready, hasWorkspace: false }), "workspace");
  assert.equal(resolveStep(undefined, { ...ready, connected: false }), "connect");
  for (const blocked of [{ connected: false }, { selected: 0 }, { indexingStarted: false }])
    assert.equal(resolveStep("summary", { ...ready, ...blocked }), "connect");
  assert.equal(resolveStep(undefined, ready), "indexing");
  assert.equal(resolveStep(undefined, { ...ready, cursor: "comments" }), "triggers");
  assert.equal(resolveStep(undefined, { ...ready, cursor: "bogus" }), "indexing");
  assert.equal(resolveStep(undefined, { ...ready, cursor: "team", completed: true }), "connect");
  assert.equal(resolveStep("tools", ready), "tools");
  assert.equal(resolveStep("workspace", ready), "connect");
  assert.equal(resolveStep("../settings", ready), "connect");
  assert.equal(nextStep("tools"), "team");
  assert.equal(nextStep("done"), undefined);
  assert.equal(previousStep("connect"), undefined);
  assert.equal(previousStep("summary"), "indexing");
  assert.deepEqual([...wizardSteps].slice(3, 7), [...configureSteps]);
  assert.equal(needsSetup({ onboarding: { startedAt: 1 } }), true);
  assert.equal(needsSetup({ onboarding: { startedAt: 1, completedAt: 2 } }), false);
  assert.equal(needsSetup({}), false);
  assert.equal(needsSetup(null), false);
});

test("each configuration step owns distinct, real workspace settings and parses only its form", () => {
  const owned = configureSteps.flatMap((s) => [...stepKeys[s]]);
  assert.equal(new Set(owned).size, owned.length);
  for (const key of owned) assert.ok(key in defaults, key);
  const form = new FormData();
  form.append("summarySections", "overview"); form.append("summarySections", "score"); form.set("commentStyle", "detailed");
  form.set("maxComments", "0"); form.set("strictness", "2"); form.append("categories", "security");
  form.set("drafts", "on"); form.set("triggerLabels", " review-me , ,later ");
  form.set("securityScan", "on");
  assert.deepEqual(stepSettingsFromForm("summary", form, defaults), { ...defaults, summarySections: ["overview", "score"], commentStyle: "detailed" });
  assert.deepEqual(stepSettingsFromForm("comments", form, defaults), { ...defaults, maxComments: 0, strictness: 2, categories: ["security"] });
  assert.deepEqual(stepSettingsFromForm("triggers", form, defaults), { ...defaults, automatic: false, drafts: true, rereview: false, threadReplies: false, triggerLabels: ["review-me", "later"] });
  assert.deepEqual(stepSettingsFromForm("tools", form, defaults), { ...defaults, securityScan: true, fixPullRequests: false });
});

test("the comments preview applies categories, confidence, severity, strictness presets and the comment limit", () => {
  const outcomes = (settings: Partial<typeof defaults>) => previewComments(sampleFindings, { ...defaults, ...settings }).map((f) => [f.id, f.outcome]);
  assert.deepEqual(outcomes({}), [["refund", "posted"], ["signature", "posted"], ["migration", "posted"], ["export", "posted"], ["test", "low confidence"], ["rates", "low confidence"]]);
  assert.deepEqual(outcomes({ strictness: 1 }).filter(([, o]) => o === "posted"), [["refund", "posted"]]);
  assert.equal(outcomes({ strictness: 3 }).filter(([, o]) => o === "posted").length, 6);
  assert.deepEqual(outcomes({ maxComments: 2 }).slice(0, 4), [["refund", "posted"], ["signature", "posted"], ["migration", "over limit"], ["export", "over limit"]]);
  assert.deepEqual(outcomes({ categories: ["correctness"] }).map(([, o]) => o), ["posted", "category off", "category off", "category off", "category off", "category off"]);
  assert.deepEqual(outcomes({ severityThreshold: "critical", minimumConfidence: 0.5 }).map(([, o]) => o), ["posted", "below severity", "below severity", "below severity", "below severity", "below severity"]);
  assert.equal(outcomes({ maxComments: 0 }).filter(([, o]) => o === "posted").length, 0);
});

test("the triggers preview matches pullRequestTrigger for every setting combination", () => {
  for (const automatic of [true, false]) for (const drafts of [true, false]) for (const rereview of [true, false]) for (const labels of [[], ["review-me"]]) {
    const settings = { automatic, drafts, rereview, triggerLabels: labels, threadReplies: true };
    for (const step of pullRequestSteps(settings)) {
      const real = pullRequestTrigger({ action: step.action, label: step.label_, pr: { draft: step.draft, base: { ref: "main" }, head: { ref: "feature" }, labels: step.prLabels.map((name) => ({ name })) } }, { ...settings, targetBranches: [], ignoredBranches: [] });
      assert.equal(pullRequestOutcome(step, settings).review, real.review, `${step.id} ${JSON.stringify(settings)}`);
    }
  }
  const timeline = triggerTimeline({ automatic: false, drafts: false, rereview: true, triggerLabels: ["ship"], threadReplies: false });
  assert.deepEqual(timeline.map((e) => [e.id, e.review]), [["draft", false], ["ready", false], ["label", true], ["push", true], ["reply", false], ["request", true]]);
});

test("the code graph layout is deterministic, bounded and falls back to folder links and a placeholder", () => {
  const files = ["src/a.ts", "src/b.ts", "lib/c.ts", "lib/d.ts", "README.md"];
  const one = graphLayout(files, [["src/a.ts", "lib/c.ts"], ["src/a.ts", "src/a.ts"], ["src/a.ts", "missing.ts"]]);
  assert.deepEqual(one, graphLayout([...files].reverse(), [["src/a.ts", "lib/c.ts"]]));
  assert.equal(one.placeholder, false);
  assert.deepEqual(one.edges, [[3, 1]]);
  for (const n of one.nodes) assert.ok(n.x >= 0 && n.x <= 320 && n.y >= 0 && n.y <= 320, JSON.stringify(n));
  assert.deepEqual(graphLayout(files, []).edges, [[1, 2], [3, 4]]);
  const empty = graphLayout([], []);
  assert.equal(empty.placeholder, true);
  assert.equal(empty.nodes.length, 18);
  assert.equal(graphLayout(Array.from({ length: 80 }, (_, i) => `f${i}.ts`), []).nodes.length, 36);
  assert.equal(litCount(10, 50, 100), 5);
  assert.equal(litCount(10, 500, 100), 10);
  assert.equal(litCount(10, 0, 0), 0);
  assert.equal(litCount(10, 3, 0), 10);
  assert.equal(litCount(0, 3, 9), 0);
});

test("GitHub installation returns only to allow-listed dashboard paths", () => {
  assert.equal(installReturnPath("/dashboard/onboarding/connect"), "/dashboard/onboarding/connect");
  for (const bad of ["//evil.example", "https://evil.example/dashboard/repositories", "/dashboard/onboarding/../../api", "/dashboard/repositories?x=1", undefined, 7])
    assert.equal(installReturnPath(bad), "/dashboard/repositories");
  assert.equal(installHref("org1", "/dashboard/onboarding/connect"), "/api/github/install?organization=org1&returnTo=%2Fdashboard%2Fonboarding%2Fconnect");
});

test("the install callback only accepts state from the same user who still administers the workspace", async () => {
  const { installTarget, installerGithubId } = await import("../src/github-install");
  const orgs = [{ _id: "org1", role: "admin" }, { _id: "org2", role: "member" }];
  assert.deepEqual(installTarget({ userId: "u1", organizationId: "org1", returnTo: "/dashboard/onboarding/connect" }, "u1", orgs), { organizationId: "org1", returnTo: "/dashboard/onboarding/connect" });
  assert.deepEqual(installTarget({ userId: "u1", organizationId: "org1", returnTo: "//evil" }, "u1", orgs).returnTo, "/dashboard/repositories");
  assert.throws(() => installTarget({ userId: "u2", organizationId: "org1" }, "u1", orgs), /another session/);
  assert.throws(() => installTarget({ organizationId: "org1" }, "u1", orgs), /another session/);
  assert.throws(() => installTarget({ userId: "u1", organizationId: "org2" }, "u1", orgs), /admin required/);
  assert.throws(() => installTarget({ userId: "u1", organizationId: "org9" }, "u1", orgs), /admin required/);
  assert.equal(installerGithubId({ githubUserId: 42 }, 7), 42);
  assert.equal(installerGithubId({ githubUserId: "42" }, 7), 7);
  assert.equal(installerGithubId({}, undefined), undefined);
});
