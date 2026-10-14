import { test } from "node:test";
import assert from "node:assert/strict";
import { eligibleTips, ticketReference, tipLine, type TipSignals } from "../src/feature-tips";
import { reviewFooter, reviewSummary } from "../src/review-summary";
import { defaults, deploymentDefaults, summarySections, validSummarySections } from "../src/review-settings";

const quiet: TipSignals = { references: "Refactor totals", connected: { linear: true, atlassian: true }, rules: 2, recentFindings: 0, dismissedFindings: 0, strictness: 0, engine: "agentic", agenticAvailable: true };

test("tips are chosen from review data in priority order", () => {
  assert.deepEqual(eligibleTips(quiet), []);
  assert.deepEqual(eligibleTips({ ...quiet, rules: 0 }).map((t) => t.key), ["rules"]);
  assert.deepEqual(eligibleTips({ ...quiet, engine: "pipeline" }).map((t) => t.key), ["agentic"]);
  assert.deepEqual(eligibleTips({ ...quiet, engine: "pipeline", agenticAvailable: false }), []);
  // Strictness: at least ten rated findings, half or more dismissed, and not already at the highest preset.
  assert.deepEqual(eligibleTips({ ...quiet, recentFindings: 10, dismissedFindings: 5 }).map((t) => t.key), ["strictness"]);
  assert.deepEqual(eligibleTips({ ...quiet, recentFindings: 10, dismissedFindings: 4 }), []);
  assert.deepEqual(eligibleTips({ ...quiet, recentFindings: 9, dismissedFindings: 9 }), []);
  assert.deepEqual(eligibleTips({ ...quiet, recentFindings: 10, dismissedFindings: 9, strictness: 3 }), []);
  const all = eligibleTips({ ...quiet, references: "Fixes ENG-42", connected: { linear: false, atlassian: false }, rules: 0, recentFindings: 12, dismissedFindings: 8, engine: "pipeline" });
  assert.deepEqual(all.map((t) => t.key), ["ticket", "strictness", "rules", "agentic"]);
});

test("ticket tips name the tracker that is referenced but not connected", () => {
  const none = { linear: false, atlassian: false };
  assert.equal(ticketReference("See https://linear.app/acme/issue/ENG-42/fix-totals", none), "linear");
  assert.equal(ticketReference("See https://acme.atlassian.net/browse/SHOP-7", none), "jira");
  assert.equal(ticketReference("Fixes ENG-42", none), "either");
  assert.equal(ticketReference("See https://linear.app/acme/issue/ENG-42", { linear: true, atlassian: false }), undefined);
  assert.equal(ticketReference("Fixes ENG-42", { linear: true, atlassian: false }), undefined, "a bare key may already be covered by the connected tracker");
  assert.equal(ticketReference("Bump utf-8 handling and sha-256 checks", none), undefined);
  assert.match(tipLine("ticket", "jira"), /^\n\n💡 \*\*Tip:\*\* This pull request mentions a Jira issue\. Connect Jira under Settings → Integrations/);
});

test("the Feature tips summary section toggles the footer tip; it never adds a summary section", () => {
  const withTips = [...defaults.summarySections, "tips"];
  assert.match(reviewFooter(2, "other", { sections: withTips, key: "rules" }), /^\n\nReview 2 on this pull request · Comment `@openreview review` to re-run it\.\n\n💡 \*\*Tip:\*\* This repository has no custom review rules\./);
  assert.equal(reviewFooter(2, "other", { sections: defaults.summarySections, key: "rules" }), reviewFooter(2, "other"));
  assert.equal(reviewFooter(2, "other", null), reviewFooter(2, "other"));
  assert.ok(validSummarySections(withTips));
  const data = { overview: "o", files: [], findings: [], resolved: [], score: undefined, assessment: undefined, runtimeEvidence: undefined, coverageLimits: [], contextCount: 0, candidates: 0, suppressed: 0 };
  assert.equal(reviewSummary(data, withTips), reviewSummary(data, defaults.summarySections));
  assert.deepEqual([...summarySections].at(-1), "tips");
});

test("feature tips default on for the hosted cloud and off for self-hosted installs", () => {
  assert.equal(defaults.summarySections.includes("tips"), false);
  assert.equal(deploymentDefaults({}).summarySections.includes("tips"), false);
  assert.equal(deploymentDefaults({ BILLING_ENABLED: "false" }).summarySections.includes("tips"), false);
  assert.deepEqual(deploymentDefaults({ BILLING_ENABLED: "true" }).summarySections, [...defaults.summarySections, "tips"]);
});
