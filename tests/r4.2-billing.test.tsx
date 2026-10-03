import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BillingSettingsView } from "@/components/usage/BillingSettingsView";
import { orgBilling } from "@/lib/billing/account";
import { checkUsageLimits, UsageLimitError } from "@/lib/billing/limits";
import { billingConfig, includedCredits, offeredPlans, type BillingConfig } from "@/lib/billing/plans";
import { reportUsage } from "@/lib/billing/report";
import { getUsageSettings } from "@/lib/billing/settings";
import { BillingDisabledError, type CheckoutSessionParams, type StripeApi, type StripeSubscription } from "@/lib/billing/stripe";
import { handleStripeEvent, openCustomerPortal, reportOverage, startCheckout, syncSeats } from "@/lib/billing/subscriptions";
import { loadBillingSettings } from "@/lib/billing/view";
import { createStripeWebhookHandler } from "@/lib/billing/webhook";
import { resolveEffectiveSettings } from "@/lib/config/settings";
import { completeInstallation } from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { billingAccounts, billingEvents, billingUsageReports, orgs, usageEvents } from "@/lib/db/schema";
import { billingEnv } from "@/lib/env";
import { MemoryQueue } from "@/lib/jobs/types";
import { requestReview } from "@/lib/pipeline/request";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";
import { pipelineFixture } from "./helpers/pipeline";
import { reviewOutput, stubEngine } from "./helpers/stub-engine";

// Built at runtime so no provider-key-shaped literal is committed.
const SECRET_KEY = ["sk", "test", "openreview", "fixture"].join("_");
const WEBHOOK_SECRET = ["whsec", "openreview", "fixture"].join("_");
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_TEAM_SEAT: "price_team_seat",
  STRIPE_PRICE_OVERAGE: "price_overage",
};

const on: BillingConfig = billingConfig(billingEnv({ APP_URL: "https://review.example.com", ...STRIPE_ENV, TEAM_INCLUDED_CREDITS_PER_SEAT: "10", FREE_MONTHLY_CREDITS: "5" }));
const off: BillingConfig = billingConfig(billingEnv({ APP_URL: "https://review.example.com" }));

/** An in-memory Stripe: records every call and keeps subscriptions. */
class FakeStripe implements StripeApi {
  calls: { method: string; args: unknown[] }[] = [];
  subscriptions = new Map<string, StripeSubscription>();
  meterEvents: { event_name: string; payload: Record<string, string>; identifier: string; timestamp: number }[] = [];
  private seq = 0;

  private log(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  async createCustomer(params: { name: string; metadata: Record<string, string> }, key: string) {
    this.log("createCustomer", params, key);
    return { id: `cus_${params.metadata.orgId}` };
  }
  async createCheckoutSession(params: CheckoutSessionParams, key: string) {
    this.log("createCheckoutSession", params, key);
    return { id: `cs_${++this.seq}`, url: `https://checkout.stripe.test/cs_${this.seq}` };
  }
  async createPortalSession(params: { customer: string; return_url: string }) {
    this.log("createPortalSession", params);
    return { url: `https://billing.stripe.test/${params.customer}` };
  }
  async retrieveSubscription(id: string) {
    this.log("retrieveSubscription", id);
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error(`no subscription ${id}`);
    return sub;
  }
  async updateSubscriptionItemQuantity(itemId: string, quantity: number, key: string) {
    this.log("updateSubscriptionItemQuantity", itemId, quantity, key);
  }
  async meterEventName(priceId: string) {
    this.log("meterEventName", priceId);
    return "openreview_overage_credits";
  }
  async createMeterEvent(params: { event_name: string; payload: Record<string, string>; identifier: string; timestamp: number }) {
    this.log("createMeterEvent", params);
    // Stripe dedupes meter events by identifier.
    if (!this.meterEvents.some((e) => e.identifier === params.identifier)) this.meterEvents.push(params);
  }
}

const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function subscription(over: Partial<StripeSubscription> & { quantity?: number; start?: string; end?: string } = {}): StripeSubscription {
  const { quantity = 2, start = "2026-10-01T00:00:00Z", end = "2026-11-01T00:00:00Z", ...rest } = over;
  return {
    id: "sub_1",
    customer: "cus_org_a",
    status: "active",
    cancel_at: null,
    metadata: { orgId: "org_a" },
    items: {
      data: [
        { id: "si_seat", price: { id: "price_team_seat" }, quantity, current_period_start: sec(start), current_period_end: sec(end) },
        { id: "si_overage", price: { id: "price_overage" }, current_period_start: sec(start), current_period_end: sec(end) },
      ],
    },
    ...rest,
  };
}

function stripeEvent(id: string, type: string, object: unknown, created = sec("2026-10-02T00:00:00Z")) {
  return { id, type, created, object: "event", data: { object } };
}

let db: Db;
let stripe: FakeStripe;
let clock: Date;
const deps = () => ({ db, cfg: on, stripe: () => stripe, now: () => clock });

async function usage(orgId: string, author: string | null, credits: number, createdAt: Date) {
  await db.insert(usageEvents).values({ orgId, kind: "review", author, credits, createdAt });
}

beforeEach(async () => {
  db = await createTestDb();
  stripe = new FakeStripe();
  clock = new Date("2026-10-05T12:00:00Z");
  await db.insert(orgs).values([
    { id: "org_a", name: "Acme" },
    { id: "org_b", name: "Beta" },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Stripe billing (R4.2)", () => {
  test("R4.2 without Stripe env billing is off: self-hosted unlimited plan, no Stripe calls, webhook answers 404", async () => {
    expect(off.enabled).toBe(false);
    expect(billingConfig(billingEnv({ STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET })).enabled).toBe(false);
    expect(offeredPlans(off).map((p) => p.id)).toEqual(["self_hosted"]);
    const billing = await orgBilling(db, "org_a", { cfg: off, now: clock });
    expect(billing).toMatchObject({ plan: { id: "self_hosted" }, includedCredits: null, account: null });

    // Many developers, many credits: nothing is limited.
    for (const a of ["a1", "a2", "a3"]) await usage("org_a", a, 500, new Date("2026-10-02T00:00:00Z"));
    expect((await checkUsageLimits(db, "org_a", { kind: "review", author: "a4" }, { cfg: off, now: () => clock })).ok).toBe(true);

    // The hourly job and every billing entry point never touch Stripe.
    const factory = vi.fn(() => stripe);
    const result = await reportUsage({ db, cfg: off, stripe: factory, now: () => clock });
    expect(result.billing).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    await expect(startCheckout({ db, cfg: off, stripe: factory }, { orgId: "org_a", orgName: "Acme" })).rejects.toBeInstanceOf(BillingDisabledError);
    await expect(openCustomerPortal({ db, cfg: off, stripe: factory }, "org_a")).rejects.toBeInstanceOf(BillingDisabledError);
    expect(factory).not.toHaveBeenCalled();
    expect(stripe.calls).toEqual([]);

    const handler = createStripeWebhookHandler(() => ({ db, cfg: off, stripe: factory }));
    const res = await handler(new Request("http://localhost/api/stripe/webhook", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=x" } }));
    expect(res.status).toBe(404);
    expect(await db.select().from(billingAccounts)).toEqual([]);

    const view = await loadBillingSettings(db, "org_a", { withSecret: false, cfg: off, now: clock });
    const html = renderToStaticMarkup(
      <BillingSettingsView {...view} canManage={false} canBill limitsForm={null} actions={{ checkout: async () => {}, portal: async () => {}, rotateSecret: async () => {} }} />,
    );
    expect(html).toContain("Self-hosted: unlimited.");
    expect(html).not.toContain("Upgrade to");
    expect(html).not.toContain("Manage billing");
  });

  test("R4.2 one plan config drives prices, allowances, and Stripe price ids from the environment", () => {
    expect(on.enabled).toBe(true);
    expect(offeredPlans(on).map((p) => p.id)).toEqual(["free", "team"]);
    expect(on.plans.free).toMatchObject({ activeDeveloperLimit: 1, includedCredits: 5, overagePriceUsd: null, stripe: null });
    expect(on.plans.team).toMatchObject({ perSeat: true, includedCreditsPerSeat: 10, stripe: { seatPrice: "price_team_seat", overagePrice: "price_overage" } });
    expect(includedCredits(on.plans.team, 3)).toBe(30);
    expect(includedCredits(on.plans.team, 0)).toBe(10);
    expect(includedCredits(on.plans.self_hosted, 3)).toBeNull();
    const defaults = billingConfig(billingEnv({}));
    expect(defaults.plans.free.includedCredits).toBe(50);
    expect(defaults.plans.team.includedCreditsPerSeat).toBe(200);
    expect(defaults.plans.team.stripe).toBeNull();
  });

  test("R4.2 checkout opens a team subscription with one seat per active developer and reuses the customer", async () => {
    for (const a of ["ann", "ben", "cy"]) await usage("org_a", a, 1, new Date("2026-10-02T00:00:00Z"));
    await usage("org_a", "ann", 1, new Date("2026-10-03T00:00:00Z"));
    await usage("org_a", "old", 1, new Date("2026-09-20T00:00:00Z"));
    await usage("org_b", "zed", 1, new Date("2026-10-02T00:00:00Z"));

    const first = await startCheckout(deps(), { orgId: "org_a", orgName: "Acme", email: "owner@acme.test" });
    expect(first).toEqual({ url: "https://checkout.stripe.test/cs_1", seats: 3 });
    const [customer, session] = stripe.calls;
    expect(customer).toMatchObject({ method: "createCustomer", args: [{ name: "Acme", email: "owner@acme.test", metadata: { orgId: "org_a" } }, "openreview-customer-org_a"] });
    expect(session!.method).toBe("createCheckoutSession");
    expect(session!.args[0]).toEqual({
      mode: "subscription",
      customer: "cus_org_a",
      client_reference_id: "org_a",
      line_items: [{ price: "price_team_seat", quantity: 3 }, { price: "price_overage" }],
      success_url: "https://review.example.com/dashboard/settings/usage?toast=billing.checkout_success",
      cancel_url: "https://review.example.com/dashboard/settings/usage?toast=billing.checkout_cancelled",
      subscription_data: { metadata: { orgId: "org_a" } },
      metadata: { orgId: "org_a" },
    });

    // A second checkout reuses the stored customer; an org with no developers yet buys one seat.
    await startCheckout(deps(), { orgId: "org_a", orgName: "Acme" });
    expect(stripe.calls.filter((c) => c.method === "createCustomer")).toHaveLength(1);
    await startCheckout(deps(), { orgId: "org_b", orgName: "Beta" });
    const lastSession = stripe.calls.filter((c) => c.method === "createCheckoutSession").at(-1)!;
    expect((lastSession.args[0] as CheckoutSessionParams).line_items[0]).toEqual({ price: "price_team_seat", quantity: 1 });
    expect(await openCustomerPortal(deps(), "org_a")).toBe("https://billing.stripe.test/cus_org_a");
  });

  test("R4.2 the webhook verifies the Stripe signature on the raw body and applies each event once", async () => {
    await db.insert(billingAccounts).values({ orgId: "org_a", stripeCustomerId: "cus_org_a" });
    const handler = createStripeWebhookHandler(() => ({ db, cfg: on, stripe: () => stripe }));
    const post = (body: string, signature: string | null) =>
      handler(new Request("http://localhost/api/stripe/webhook", { method: "POST", body, headers: signature ? { "stripe-signature": signature } : {} }));
    const payload = JSON.stringify(stripeEvent("evt_1", "customer.subscription.updated", subscription({ quantity: 4 })));

    expect((await post(payload, null)).status).toBe(400);
    expect((await post(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: ["whsec", "wrong"].join("_") }))).status).toBe(400);
    // A body changed after signing does not verify either.
    const signed = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    expect((await post(payload.replace('"quantity":4', '"quantity":40'), signed)).status).toBe(400);
    expect(await db.select().from(billingEvents)).toEqual([]);

    const ok = await post(payload, signed);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ received: true, duplicate: false, outcome: "applied: team (active)" });
    const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, "org_a"));
    expect(account).toMatchObject({ plan: "team", status: "active", seats: 4, stripeSubscriptionId: "sub_1", stripeSeatItemId: "si_seat" });
    expect(account!.currentPeriodStart?.toISOString()).toBe("2026-10-01T00:00:00.000Z");

    // Redelivery: acknowledged, not applied again (a manual change in between survives).
    await db.update(billingAccounts).set({ seats: 9 }).where(eq(billingAccounts.orgId, "org_a"));
    const again = await post(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }));
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect((await db.select().from(billingAccounts))[0]!.seats).toBe(9);
    expect(await db.select().from(billingEvents)).toMatchObject([{ id: "evt_1", orgId: "org_a", type: "customer.subscription.updated" }]);
  });

  test("R4.2 subscription events move the org between the free and team plans", async () => {
    await db.insert(billingAccounts).values({ orgId: "org_a", stripeCustomerId: "cus_org_a" });
    stripe.subscriptions.set("sub_1", subscription({ quantity: 2 }));
    const apply = (id: string, type: string, object: unknown, created?: number) => handleStripeEvent(deps(), { id, type, created: created ?? sec("2026-10-02T00:00:00Z"), data: { object: object as Record<string, unknown> } });
    const account = async () => (await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, "org_a")))[0]!;
    expect((await orgBilling(db, "org_a", { cfg: on, now: clock })).plan.id).toBe("free");

    // Checkout completed: the subscription's state comes from Stripe.
    const done = await apply("evt_c", "checkout.session.completed", { id: "cs_1", mode: "subscription", customer: "cus_org_a", subscription: "sub_1", client_reference_id: "org_a" });
    expect(done.outcome).toBe("applied: team (active)");
    expect(stripe.calls.map((c) => c.method)).toEqual(["retrieveSubscription"]);
    const billing = await orgBilling(db, "org_a", { cfg: on, now: clock });
    expect(billing).toMatchObject({ plan: { id: "team" }, seats: 2, includedCredits: 20 });
    expect(billing.period.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");

    // A checkout whose reference names another org is not applied.
    expect((await apply("evt_x", "checkout.session.completed", { id: "cs_2", mode: "subscription", customer: "cus_org_a", subscription: "sub_1", client_reference_id: "org_b" })).outcome).toMatch(/^ignored/);

    // Payment trouble keeps the plan while Stripe retries; the failure is recorded.
    await apply("evt_f", "invoice.payment_failed", { id: "in_1", customer: "cus_org_a" }, sec("2026-10-03T00:00:00Z"));
    expect((await account()).paymentFailedAt?.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    await apply("evt_u1", "customer.subscription.updated", subscription({ status: "past_due" }), sec("2026-10-03T00:00:01Z"));
    expect(await account()).toMatchObject({ plan: "team", status: "past_due" });

    // An older event delivered late does not overwrite newer state.
    expect((await apply("evt_old", "customer.subscription.updated", subscription({ quantity: 7 }), sec("2026-10-01T00:00:00Z"))).outcome).toMatch(/older/);
    expect((await account()).seats).toBe(2);

    // Scheduled cancellation, then deletion: back to the free plan.
    await apply("evt_u2", "customer.subscription.updated", subscription({ cancel_at: sec("2026-11-01T00:00:00Z") }), sec("2026-10-04T00:00:00Z"));
    expect((await account()).cancelAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    await apply("evt_d", "customer.subscription.deleted", subscription({ status: "canceled" }), sec("2026-10-05T00:00:00Z"));
    expect(await account()).toMatchObject({ plan: "free", status: "canceled", seats: 0, stripeSubscriptionId: null });
    expect((await orgBilling(db, "org_a", { cfg: on, now: clock })).plan.id).toBe("free");

    // Unknown customers and unhandled event types are acknowledged and ignored.
    expect((await apply("evt_n", "customer.subscription.updated", subscription({ customer: "cus_unknown" }))).outcome).toBe("ignored: unknown customer");
    expect((await apply("evt_t", "charge.refunded", { id: "ch_1" })).outcome).toBe("ignored: unhandled event charge.refunded");
  });

  test("R4.2 overage credits are reported to the Stripe meter once per period", async () => {
    await db.insert(billingAccounts).values({
      orgId: "org_a",
      stripeCustomerId: "cus_org_a",
      stripeSubscriptionId: "sub_1",
      stripeSeatItemId: "si_seat",
      plan: "team",
      status: "active",
      seats: 1,
      currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    });
    // 10 credits included (1 seat); 14 used.
    await usage("org_a", "ann", 8, new Date("2026-10-02T00:00:00Z"));
    await usage("org_a", "ann", 6, new Date("2026-10-03T00:00:00Z"));
    await usage("org_a", "ann", 50, new Date("2026-09-30T00:00:00Z"));

    expect(await reportOverage(deps(), "org_a")).toMatchObject({ overage: 4, reported: 4 });
    expect(stripe.meterEvents).toEqual([
      { event_name: "openreview_overage_credits", payload: { stripe_customer_id: "cus_org_a", value: "4" }, identifier: `openreview-overage-org_a-${sec("2026-10-01T00:00:00Z")}-4`, timestamp: sec("2026-10-05T12:00:00Z") },
    ]);
    // Re-running (a retried or overlapping job) reports nothing more.
    expect(await reportOverage(deps(), "org_a")).toMatchObject({ overage: 4, reported: 0 });
    expect(stripe.calls.filter((c) => c.method === "createMeterEvent")).toHaveLength(1);

    await usage("org_a", "ann", 3, new Date("2026-10-05T00:00:00Z"));
    expect(await reportOverage(deps(), "org_a")).toMatchObject({ overage: 7, reported: 3 });
    expect(stripe.meterEvents.map((e) => e.payload.value)).toEqual(["4", "3"]);
    expect(await db.select().from(billingUsageReports)).toMatchObject([{ orgId: "org_a", reportedCredits: 7 }]);

    // Under the allowance, or not on the team plan: nothing is reported.
    expect(await reportOverage(deps(), "org_b")).toMatchObject({ overage: 0, reported: 0 });
    expect(stripe.meterEvents).toHaveLength(2);
  });

  test("R4.2 seat sync grows the subscription to the period's active developers, prorated", async () => {
    await db.insert(billingAccounts).values({
      orgId: "org_a",
      stripeCustomerId: "cus_org_a",
      stripeSubscriptionId: "sub_1",
      stripeSeatItemId: "si_seat",
      plan: "team",
      status: "active",
      seats: 2,
      currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    });
    await usage("org_a", "ann", 1, new Date("2026-10-02T00:00:00Z"));
    await usage("org_a", "ben", 1, new Date("2026-10-02T00:00:00Z"));
    expect(await syncSeats(deps(), "org_a")).toBeNull();
    await usage("org_a", "cy", 1, new Date("2026-10-03T00:00:00Z"));
    await usage("org_a", null, 1, new Date("2026-10-03T00:00:00Z"));
    expect(await syncSeats(deps(), "org_a")).toEqual({ from: 2, to: 3 });
    expect(stripe.calls.find((c) => c.method === "updateSubscriptionItemQuantity")!.args.slice(0, 2)).toEqual(["si_seat", 3]);
    expect((await db.select().from(billingAccounts))[0]!.seats).toBe(3);
    expect(await syncSeats(deps(), "org_a")).toBeNull();

    // The hourly job runs seat sync then overage reporting for team subscriptions.
    await usage("org_a", "dee", 40, new Date("2026-10-04T00:00:00Z"));
    const result = await reportUsage({ db, cfg: on, stripe: () => stripe, now: () => clock });
    expect(result.billing).toEqual({ orgs: 1, failed: 0 });
    expect((await db.select().from(billingAccounts))[0]!.seats).toBe(4);
    // 44 credits used, 4 seats × 10 included.
    expect(stripe.meterEvents.map((e) => e.payload.value)).toEqual(["4"]);

    // The billing page shows the plan, seats, and usage against the included credits; owners manage it in Stripe.
    const view = await loadBillingSettings(db, "org_a", { withSecret: false, cfg: on, now: clock });
    expect(view.billing).toMatchObject({ plan: { id: "team" }, seats: 4, includedCredits: 40, creditsUsed: 44, activeDevelopers: 4 });
    const noop = async () => {};
    const owner = renderToStaticMarkup(<BillingSettingsView {...view} canManage canBill limitsForm={<p>form</p>} actions={{ checkout: noop, portal: noop, rotateSecret: noop }} />);
    expect(owner).toContain("Manage billing");
    expect(owner).toContain("4 seats × $24.00 / month");
    expect(owner).toContain("4 overage credits");
    const member = renderToStaticMarkup(<BillingSettingsView {...view} canManage={false} canBill={false} limitsForm={<p>form</p>} actions={{ checkout: noop, portal: noop, rotateSecret: noop }} />);
    expect(member).not.toContain("Manage billing");
    expect(member).toContain("Only owners and admins can change the plan.");
    expect(member).not.toContain("<p>form</p>");
  });

  test("R4.2 the free plan reviews only the period's first active developer and stops at its included credits", async () => {
    for (const [k, v] of Object.entries({ ...STRIPE_ENV, FREE_MONTHLY_CREDITS: "5" })) vi.stubEnv(k, v);
    const now = new Date();

    // Webhook: bob's PR is skipped with a one-time explanation while alice is the active developer.
    const host = new FakeGitHost();
    host.addInstallation(12, "beta", [{ id: 2, fullName: "beta/app", defaultBranch: "main", private: true }]);
    const { repos } = await completeInstallation(db, host, { orgId: "org_b", orgName: "Beta", installationId: 12 });
    await usage("org_b", "alice", 2, now);
    const queue = new MemoryQueue();
    const gate = { draft: false, baseRef: "main", headRef: "feature", settings: resolveEffectiveSettings(undefined, undefined, undefined).settings };
    const asBob = await requestReview({ db, queue }, { orgId: "org_b", repoId: repos[0]!.id, prNumber: 3, headSha: "h1", trigger: "opened", author: "bob", gate });
    expect(asBob).toMatchObject({ limited: true, code: "free_plan" });
    if ("limited" in asBob) expect(asBob.reason).toContain("@alice is already active this period, so @bob's pull request was not reviewed");
    await expect(requestReview({ db, queue }, { orgId: "org_b", repoId: repos[0]!.id, prNumber: 3, trigger: "manual", author: "bob" })).rejects.toBeInstanceOf(UsageLimitError);
    const asAlice = await requestReview({ db, queue }, { orgId: "org_b", repoId: repos[0]!.id, prNumber: 4, headSha: "h2", trigger: "opened", author: "Alice", gate });
    expect(asAlice).toMatchObject({ deduped: false });
    expect(queue.jobs).toHaveLength(1);

    // The job checks again once it knows the PR author (a manual request named none).
    const fx = await pipelineFixture();
    await fx.db.insert(usageEvents).values({ orgId: "org_a", kind: "review", author: "alice", credits: 1, createdAt: now });
    const res = await fx.review(stubEngine(() => reviewOutput()).run);
    expect(res.status).toBe("skipped");
    expect(res.reason).toMatch(/^free_plan: .*@dana's pull request was not reviewed/);

    // Once the free credits are used up, even the active developer waits for the next period.
    await fx.db.insert(usageEvents).values({ orgId: "org_a", kind: "review", author: "alice", credits: 4, createdAt: now });
    const verdict = await checkUsageLimits(fx.db, "org_a", { kind: "review", author: "alice" });
    expect(verdict).toMatchObject({ ok: false, code: "free_plan" });
    if (!verdict.ok) expect(verdict.reason).toContain("free plan's 5 credits for this period are used up");
    expect((await getUsageSettings(fx.db, "org_a")).monthlyCreditCap).toBeNull();
    fx.fixture.cleanup();
  });
});
