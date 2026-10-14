import { test } from "node:test";
import assert from "node:assert/strict";
import { billingConfig, capThresholds, creditConfig, creditCost, creditDecision, type CreditAccount } from "../src/billing";

const day = 86_400_000, now = Date.UTC(2026, 9, 14);
const config = billingConfig({ BILLING_ENABLED: "true", BILLING_GRACE_DAYS: "7" });
const credits = creditConfig({ BILLING_ENABLED: "true", BILLING_CREDITS_PER_SEAT: "10", BILLING_TRIAL_CREDITS: "5", BILLING_FREE_CREDITS: "4", BILLING_FREE_SEATS: "1", BILLING_OVERAGE_CREDIT_USD: "0.5" });
const team: CreditAccount = { status: "active", seats: 2, trialEndsAt: now - day, subscriptionId: "sub_1", billedSeats: 2 };
const used = (credits: number, overageCredits = 0) => ({ credits, overageCredits });

test("defaults reproduce the review quota: one credit per review, seats × reviews per seat, trial reviews", () => {
  const d = creditConfig({});
  assert.deepEqual([d.perReview, d.perGeneratedTestReview, d.perSeat, d.trial, d.free, d.freeSeats, d.overageUsd, d.meterEvent], [1, 3, 100, 200, 0, 1, 0.5, "openreview_credits"]);
  assert.equal(creditConfig({ BILLING_REVIEWS_PER_SEAT: "40" }).perSeat, 40);
  assert.deepEqual([creditCost("review", d), creditCost("generated-tests", d)], [1, 2], "a generated-test review costs 3 in total: 1 at enqueue + 2 for the tests");
  assert.equal(creditDecision(team, used(10_000), 1, now, billingConfig({}), credits).allowed, true, "BILLING_ENABLED unset never charges");
});

test("credit accounting: included credits, then extra credits, then nothing without a cap", () => {
  assert.deepEqual(creditDecision(team, used(19), 1, now, config, credits), { allowed: true, plan: "team", source: "included", included: 20, used: 19, extra: 0, overageUsd: 0, capUsd: 0 });
  assert.equal(creditDecision(team, used(19), 2, now, config, credits).allowed, false, "a 2-credit charge does not fit in 1 remaining credit");
  assert.equal(creditDecision({ ...team, extraCredits: 5 }, used(20), 2, now, config, credits).source, "extra");
  const out = creditDecision({ ...team, extraCredits: 1 }, used(20), 2, now, config, credits);
  assert.equal(out.allowed, false);
  assert.match(out.reason!, /used its 20 credits .* Add seats, buy credits or set a spending cap/);
  assert.equal(creditDecision(team, used(0), 0, now, config, credits).allowed, true, "zero-cost charges always pass");
  const trial = { ...team, subscriptionId: undefined, status: "trial", trialEndsAt: now + day, billedSeats: 3 };
  assert.deepEqual([creditDecision(trial, used(4), 1, now, config, credits).plan, creditDecision(trial, used(5), 1, now, config, credits).reason], ["trial", "The trial includes 5 credits per month. Subscribe in Settings → Billing for more."]);
});

test("spending cap: metered overage until the cap, then a pause with the reason; past-due grace still applies", () => {
  const capped = { ...team, spendCapUsd: 1 };
  assert.equal(creditDecision(capped, used(20, 0), 1, now, config, credits).source, "overage");
  assert.equal(creditDecision(capped, used(20, 1), 1, now, config, credits).source, "overage", "$1.00 reaches but does not pass the cap");
  const paused = creditDecision(capped, used(20, 2), 1, now, config, credits);
  assert.deepEqual([paused.allowed, paused.overageUsd, paused.capUsd], [false, 1, 1]);
  assert.match(paused.reason!, /reached its monthly spending cap of \$1\.00\. Reviews resume next month/);
  assert.equal(creditDecision({ ...capped, subscriptionId: undefined, status: "trial", trialEndsAt: now + day }, used(5), 1, now, config, credits).allowed, false, "trial workspaces have no overage");
  assert.match(creditDecision({ ...capped, status: "past_due", pastDueSince: now - 8 * day }, used(0), 1, now, config, credits).reason!, /grace period has ended/);
  assert.deepEqual([capThresholds(0.5, 1), capThresholds(0.8, 1), capThresholds(1, 1), capThresholds(1, 1, [80]), capThresholds(1, 1, [80, 100]), capThresholds(5, 0)], [[], [80], [80, 100], [100], [], []]);
});

test("free plan: after the trial, small workspaces keep a monthly allowance; larger ones must subscribe", () => {
  const solo: CreditAccount = { status: "trial", seats: 0, trialEndsAt: now - day, billedSeats: 1 };
  assert.deepEqual([creditDecision(solo, used(3), 1, now, config, credits).plan, creditDecision(solo, used(3), 1, now, config, credits).allowed], ["free", true]);
  assert.match(creditDecision(solo, used(4), 1, now, config, credits).reason!, /free plan includes 4 credits per month/);
  assert.equal(creditDecision({ ...solo, extraCredits: 10 }, used(4), 1, now, config, credits).source, "extra", "purchased credits extend the free plan");
  assert.match(creditDecision({ ...solo, billedSeats: 2 }, used(0), 1, now, config, credits).reason!, /free plan covers 1 developer and this workspace has 2/);
  // Without BILLING_FREE_CREDITS the trial simply ends, as before.
  assert.match(creditDecision(solo, used(0), 1, now, config, { ...credits, free: 0 }).reason!, /free trial has ended/);
});
