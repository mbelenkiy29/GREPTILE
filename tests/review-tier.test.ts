import { test } from "node:test";
import assert from "node:assert/strict";
import { isTierLabel, labelTier, resolveTier, reviewCommand } from "../src/review-tier";
import { defaults } from "../src/review-settings";

test("@openreview review commands carry an optional tier or the security focus", () => {
  assert.deepEqual(reviewCommand("@openreview review"), {});
  assert.deepEqual(reviewCommand("@openreview review again please"), {});
  assert.deepEqual(reviewCommand("@openreview review security"), { category: "security" });
  assert.deepEqual(reviewCommand("@OpenReview Review DEEP"), { mode: "deep" });
  assert.deepEqual(reviewCommand("Could you run @openreview review fast on this?"), { mode: "fast" });
  assert.deepEqual(reviewCommand("@openreview review standard"), { mode: "standard" });
  assert.deepEqual(reviewCommand("@openreview review deeply"), {}, "only whole words select a tier");
  assert.equal(reviewCommand("review deep"), null);
  assert.equal(reviewCommand("@openreview explain this"), null);
});

test("openreview:<tier> labels select a tier; the highest of several wins; other labels are ignored", () => {
  assert.equal(labelTier(["bug", "openreview:deep"]), "deep");
  assert.equal(labelTier(["OpenReview:Fast"]), "fast");
  assert.equal(labelTier(["openreview:fast", "openreview:deep", "openreview:standard"]), "deep");
  assert.equal(labelTier(["openreview", "openreview:huge", "needs-review"]), undefined);
  assert.ok(isTierLabel(" openreview:standard ") && !isTierLabel("openreview:"));
});

test("precedence: comment over label over configured tier; the admin cap applies last", () => {
  assert.deepEqual(resolveTier({ configured: "standard" }), { mode: "standard", source: "settings", capped: false, requested: "standard" });
  assert.deepEqual(resolveTier({ configured: "standard", requested: { mode: "deep", source: "label" } }), { mode: "deep", source: "label", capped: false, requested: "deep" });
  // A comment may also lower the tier for one run.
  assert.deepEqual(resolveTier({ configured: "deep", requested: { mode: "fast", source: "comment" } }), { mode: "fast", source: "comment", capped: false, requested: "fast" });
  // Caps: a workspace limit of standard stops deep from comments, labels and folders alike.
  assert.deepEqual(resolveTier({ configured: "standard", requested: { mode: "deep", source: "comment" }, cap: "standard" }), { mode: "standard", source: "comment", capped: true, requested: "deep" });
  assert.deepEqual(resolveTier({ configured: "deep", cap: "standard" }), { mode: "standard", source: "settings", capped: true, requested: "deep" });
  assert.deepEqual(resolveTier({ configured: "deep", requested: { mode: "deep", source: "label" }, cap: "fast" }).mode, "fast");
  assert.equal(resolveTier({ configured: "fast", cap: "standard" }).capped, false);
  assert.equal(defaults.maxReviewTier, "deep", "no cap by default");
});
