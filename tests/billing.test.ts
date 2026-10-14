import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { billingConfig, billingDecision, formEncode, periodKey, seatCount, stripe, stripeKey, verifyStripeSignature } from "../src/billing";

const config = billingConfig({ BILLING_ENABLED: "true", BILLING_TRIAL_REVIEWS: "3", BILLING_REVIEWS_PER_SEAT: "10", BILLING_GRACE_DAYS: "7" });
const now = Date.UTC(2026, 9, 14), day = 86400000;

test("billing configuration defaults to disabled and validates numbers", () => {
  assert.deepEqual(billingConfig({}), { enabled: false, trialDays: 14, trialReviews: 200, reviewsPerSeat: 100, graceDays: 7 });
  assert.equal(billingConfig({ BILLING_ENABLED: "yes" }).enabled, false);
  assert.equal(billingConfig({ BILLING_TRIAL_DAYS: "-1", BILLING_REVIEWS_PER_SEAT: "abc" }).trialDays, 14);
  assert.equal(periodKey(now), "2026-10");
});

test("seats count owners, admins and members; viewers are free", () => {
  assert.equal(seatCount([{ role: "owner" }, { role: "admin" }, { role: "member" }, { role: "viewer" }, { role: "viewer" }]), 3);
  assert.equal(seatCount([]), 0);
});

test("quota decisions: trial, per-seat team quota, past-due grace, and lapsed subscriptions", () => {
  const trial = { status: "trial", seats: 0, trialEndsAt: now + 5 * day };
  assert.equal(billingDecision(trial, 999, now, billingConfig({})).allowed, true, "disabled billing never blocks");
  assert.deepEqual(billingDecision(trial, 2, now, config), { allowed: true, plan: "trial", limit: 3, used: 2 });
  assert.match(billingDecision(trial, 3, now, config).reason!, /trial includes 3 reviews/);
  assert.match(billingDecision({ ...trial, trialEndsAt: now }, 0, now, config).reason!, /free trial has ended/);
  const team = { status: "active", seats: 4, trialEndsAt: now - day, subscriptionId: "sub_1" };
  assert.deepEqual(billingDecision(team, 39, now, config), { allowed: true, plan: "team", limit: 40, used: 39 });
  assert.match(billingDecision(team, 40, now, config).reason!, /used its 40 reviews/);
  assert.equal(billingDecision({ ...team, status: "past_due", pastDueSince: now - 6 * day }, 0, now, config).allowed, true, "within grace");
  assert.match(billingDecision({ ...team, status: "past_due", pastDueSince: now - 7 * day }, 0, now, config).reason!, /grace period has ended/);
  assert.match(billingDecision({ ...team, status: "canceled" }, 0, now, config).reason!, /free trial has ended/);
  assert.equal(billingDecision({ ...team, status: "canceled", trialEndsAt: now + day }, 0, now, config).plan, "trial", "a lapsed subscription falls back to any remaining trial");
  assert.equal(billingDecision({ ...team, seats: 0 }, 9, now, config).limit, 10, "at least one seat");
});

const secret = "whsec_fixture", payload = '{"id":"evt_1"}';
const header = (body: string, t: number, key = secret) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
test("Stripe signatures: exact payload, any listed v1 signature, five-minute tolerance", async () => {
  const t = Math.floor(now / 1000);
  assert.equal(await verifyStripeSignature(payload, header(payload, t), secret, now), true);
  assert.equal(await verifyStripeSignature(payload, `t=${t},v1=${"0".repeat(64)},${header(payload, t).split(",")[1]}`, secret, now), true, "secret rotation sends two signatures");
  assert.equal(await verifyStripeSignature(payload + " ", header(payload, t), secret, now), false);
  assert.equal(await verifyStripeSignature(payload, header(payload, t, "whsec_other"), secret, now), false);
  assert.equal(await verifyStripeSignature(payload, header(payload, t - 301), secret, now), false, "replayed after tolerance");
  assert.equal(await verifyStripeSignature(payload, `v1=${"a".repeat(64)}`, secret, now), false);
  assert.equal(await verifyStripeSignature(payload, header(payload, t).replace("v1=", "v0="), secret, now), false);
  assert.equal(await verifyStripeSignature(payload, header(payload, t), undefined, now), false);
});

test("Stripe client: test-mode keys only by default, nested form encoding, idempotency keys", async () => {
  assert.throws(() => stripeKey({}), /Configure STRIPE_SECRET_KEY/);
  assert.equal(stripeKey({ STRIPE_SECRET_KEY: "sk_test_123" }), "sk_test_123");
  assert.throws(() => stripeKey({ STRIPE_SECRET_KEY: "sk_live_123" }), /test-mode key/);
  assert.equal(stripeKey({ STRIPE_SECRET_KEY: "sk_live_123", BILLING_ALLOW_LIVE: "true" }), "sk_live_123");
  assert.deepEqual(formEncode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 3 }], metadata: { organizationId: "org 1" }, skip: undefined }), ["mode=subscription", "line_items%5B0%5D%5Bprice%5D=price_1", "line_items%5B0%5D%5Bquantity%5D=3", "metadata%5BorganizationId%5D=org%201"]);
  let seen: { url: string; init?: RequestInit } | undefined;
  const ok = (async (url: string | URL | Request, init?: RequestInit) => { seen = { url: String(url), init }; return Response.json({ id: "cus_1" }); }) as typeof fetch;
  assert.deepEqual(await stripe("/v1/customers", { metadata: { organizationId: "o" } }, "sk_test_1", ok, "customer:o"), { id: "cus_1" });
  assert.equal(seen?.url, "https://api.stripe.com/v1/customers");
  assert.equal(new Headers(seen?.init?.headers).get("idempotency-key"), "customer:o");
  assert.equal(new Headers(seen?.init?.headers).get("authorization"), "Bearer sk_test_1");
  await assert.rejects(stripe("/v1/customers", {}, "sk_test_1", (async () => Response.json({ error: { type: "card_error" } }, { status: 402 })) as typeof fetch), /402 card_error/);
  await assert.rejects(stripe("https://evil.example", {}, "sk_test_1", ok), /Invalid Stripe API path/);
});
