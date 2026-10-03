/**
 * Stripe billing flows (R4.2): checkout for the team plan, the customer portal, webhook processing, seat sync, and
 * metered overage reporting. Every entry point requires a configuration with Stripe on and creates the Stripe client
 * lazily through `deps.stripe()`, so with billing off no Stripe code path runs.
 *
 * State: `billing_accounts` mirrors the org's Stripe customer and subscription. Webhook events are verified (see
 * `verifyStripeEvent`), applied from the object they carry, and recorded in `billing_events` by id, so a redelivered
 * event is applied once; an event older than the newest one applied (`lastEventAt`) never overwrites newer state.
 * The org of an event is always found by its Stripe customer id, which OpenReview created and stored at checkout.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { billingAccounts, billingEvents, billingUsageReports } from "@/lib/db/schema";
import { isSystemOrg } from "@/lib/demo/ids";
import { activeDevelopers, periodTotals } from "@/lib/data/usage";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { calendarPeriod, getBillingAccount, hasPaidPlan, usagePeriod, type BillingAccount } from "./account";
import { includedCredits, PAID_STATUSES, type BillingConfig } from "./plans";
import {
  BillingDisabledError,
  checkoutSessionObject,
  invoiceObject,
  subscriptionObject,
  type StripeApi,
  type StripeEvent,
  type StripeSubscription,
} from "./stripe";

export interface BillingDeps {
  db: Db;
  cfg: BillingConfig;
  /** Creates (or returns) the Stripe client; only called when billing is on. */
  stripe: () => StripeApi;
  now?: () => Date;
  log?: Logger;
}

/** A billing action that cannot be done in the org's current state (shown to the user as is). */
export class BillingError extends Error {}

function enabled(deps: BillingDeps): asserts deps is BillingDeps & { cfg: BillingConfig & { stripe: NonNullable<BillingConfig["stripe"]> } } {
  if (!deps.cfg.enabled || !deps.cfg.stripe) throw new BillingDisabledError();
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const fromSeconds = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);

/** The org's Stripe customer, created (once, idempotently) on first use. */
async function ensureCustomer(deps: BillingDeps, org: { orgId: string; orgName: string; email?: string | null }): Promise<string> {
  const existing = await getBillingAccount(deps.db, org.orgId);
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;
  const customer = await deps.stripe().createCustomer(
    { name: org.orgName, ...(org.email ? { email: org.email } : {}), metadata: { orgId: org.orgId } },
    `openreview-customer-${org.orgId}`,
  );
  await deps.db
    .insert(billingAccounts)
    .values({ orgId: org.orgId, stripeCustomerId: customer.id })
    .onConflictDoUpdate({ target: billingAccounts.orgId, set: { stripeCustomerId: sql`coalesce(${billingAccounts.stripeCustomerId}, excluded.stripe_customer_id)` } });
  const account = await getBillingAccount(deps.db, org.orgId);
  return account!.stripeCustomerId!;
}

/**
 * A Checkout Session for the team plan: one seat per active developer of the current period (at least 1) plus the
 * metered overage price. Returns the URL to send the owner to.
 */
export async function startCheckout(deps: BillingDeps, org: { orgId: string; orgName: string; email?: string | null }): Promise<{ url: string; seats: number }> {
  enabled(deps);
  const now = deps.now?.() ?? new Date();
  const account = await getBillingAccount(deps.db, org.orgId);
  if (hasPaidPlan(account)) throw new BillingError("This organization already has a team subscription. Use “Manage billing” to change it.");
  const customer = await ensureCustomer(deps, org);
  const seats = Math.max(1, (await activeDevelopers(deps.db, org.orgId, calendarPeriod(now))).length);
  const base = `${deps.cfg.appUrl}/dashboard/settings/usage`;
  const session = await deps.stripe().createCheckoutSession(
    {
      mode: "subscription",
      customer,
      client_reference_id: org.orgId,
      line_items: [{ price: deps.cfg.stripe.seatPrice, quantity: seats }, { price: deps.cfg.stripe.overagePrice }],
      success_url: `${base}?toast=billing.checkout_success`,
      cancel_url: `${base}?toast=billing.checkout_cancelled`,
      subscription_data: { metadata: { orgId: org.orgId } },
      metadata: { orgId: org.orgId },
    },
    // A double submit within the same minute returns the same session.
    `openreview-checkout-${org.orgId}-${seats}-${Math.floor(now.getTime() / 60_000)}`,
  );
  if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
  (deps.log ?? rootLog).info("stripe checkout session created", { orgId: org.orgId, seats, sessionId: session.id });
  return { url: session.url, seats };
}

/** A Customer Portal session to manage payment methods, invoices, seats, and cancellation. */
export async function openCustomerPortal(deps: BillingDeps, orgId: string): Promise<string> {
  enabled(deps);
  const account = await getBillingAccount(deps.db, orgId);
  if (!account?.stripeCustomerId) throw new BillingError("This organization has no billing account yet. Upgrade to the team plan first.");
  const session = await deps.stripe().createPortalSession({ customer: account.stripeCustomerId, return_url: `${deps.cfg.appUrl}/dashboard/settings/usage` });
  return session.url;
}

// ---- webhooks

async function accountByCustomer(db: Db, customerId: string | null | undefined): Promise<BillingAccount | null> {
  if (!customerId) return null;
  const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.stripeCustomerId, customerId));
  return row ?? null;
}

/**
 * Mirrors a subscription onto its org's account. A paid status with the seat price means the team plan; anything else
 * (canceled, unpaid, incomplete) puts the org back on the free plan. Events for another subscription than the one in
 * force cannot downgrade it.
 */
async function applySubscription(deps: BillingDeps, sub: StripeSubscription, eventAt: Date, deleted = false): Promise<{ orgId: string | null; outcome: string }> {
  enabled(deps);
  const account = await accountByCustomer(deps.db, sub.customer);
  if (!account) return { orgId: null, outcome: "ignored: unknown customer" };
  if (account.lastEventAt && eventAt < account.lastEventAt) return { orgId: account.orgId, outcome: "ignored: older than the state already applied" };
  const paid = !deleted && PAID_STATUSES.has(sub.status);
  if (account.stripeSubscriptionId && account.stripeSubscriptionId !== sub.id && hasPaidPlan(account) && !paid) {
    return { orgId: account.orgId, outcome: "ignored: not the subscription in force" };
  }
  const seatItem = sub.items.data.find((i) => i.price.id === deps.cfg.stripe.seatPrice);
  const team = paid && Boolean(seatItem);
  const periodItem = seatItem ?? sub.items.data[0];
  await deps.db
    .update(billingAccounts)
    .set({
      stripeSubscriptionId: deleted ? null : sub.id,
      stripeSeatItemId: deleted ? null : (seatItem?.id ?? null),
      plan: team ? "team" : "free",
      status: deleted ? "canceled" : sub.status,
      seats: team ? Math.max(1, seatItem?.quantity ?? 1) : 0,
      currentPeriodStart: team ? fromSeconds(periodItem?.current_period_start) : null,
      currentPeriodEnd: team ? fromSeconds(periodItem?.current_period_end) : null,
      cancelAt: deleted ? null : fromSeconds(sub.cancel_at),
      ...(team && sub.status === "active" ? { paymentFailedAt: null } : {}),
      lastEventAt: eventAt,
    })
    .where(eq(billingAccounts.orgId, account.orgId));
  return { orgId: account.orgId, outcome: `applied: ${team ? "team" : "free"} (${deleted ? "canceled" : sub.status})` };
}

/**
 * Applies one verified Stripe event, at most once per event id. Returns what was decided; throws (so Stripe retries)
 * only when applying failed.
 */
export async function handleStripeEvent(deps: BillingDeps, event: StripeEvent): Promise<{ duplicate: boolean; outcome: string }> {
  enabled(deps);
  const log = (deps.log ?? rootLog).child({ component: "stripe-webhook", stripeEventId: event.id, stripeEventType: event.type });
  const [seen] = await deps.db.select({ outcome: billingEvents.outcome }).from(billingEvents).where(eq(billingEvents.id, event.id));
  if (seen) return { duplicate: true, outcome: seen.outcome };

  const eventAt = new Date(event.created * 1000);
  const object = event.data.object;
  let result: { orgId: string | null; outcome: string };
  switch (event.type) {
    case "checkout.session.completed": {
      const session = checkoutSessionObject.parse(object);
      if (session.mode !== "subscription" || !session.subscription) {
        result = { orgId: null, outcome: "ignored: not a subscription checkout" };
        break;
      }
      const account = await accountByCustomer(deps.db, session.customer);
      if (!account || (session.client_reference_id && session.client_reference_id !== account.orgId)) {
        log.warn("checkout session does not match a billing account", { customer: session.customer ?? null });
        result = { orgId: account?.orgId ?? null, outcome: "ignored: customer does not match the organization" };
        break;
      }
      // The session carries only the subscription id; its current state comes from Stripe.
      const sub = await deps.stripe().retrieveSubscription(session.subscription);
      result = await applySubscription(deps, sub, eventAt);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = subscriptionObject.parse(object);
      result = await applySubscription(deps, sub, eventAt, event.type === "customer.subscription.deleted");
      break;
    }
    case "invoice.payment_failed": {
      const invoice = invoiceObject.parse(object);
      const account = await accountByCustomer(deps.db, invoice.customer);
      if (!account) {
        result = { orgId: null, outcome: "ignored: unknown customer" };
        break;
      }
      await deps.db.update(billingAccounts).set({ paymentFailedAt: eventAt }).where(eq(billingAccounts.orgId, account.orgId));
      result = { orgId: account.orgId, outcome: "applied: payment failed" };
      break;
    }
    default:
      result = { orgId: null, outcome: `ignored: unhandled event ${event.type}` };
  }
  await deps.db.insert(billingEvents).values({ id: event.id, orgId: result.orgId, type: event.type, outcome: result.outcome }).onConflictDoNothing();
  log.info("stripe event processed", { orgId: result.orgId, outcome: result.outcome });
  return { duplicate: false, outcome: result.outcome };
}

// ---- seat sync and overage reporting

/**
 * Seat sync: when the period's active developers outnumber the paid seats, the seat quantity grows to match
 * (prorated). Seats never shrink automatically. Returns the change, or null when none was needed.
 */
export async function syncSeats(deps: BillingDeps, orgId: string): Promise<{ from: number; to: number } | null> {
  enabled(deps);
  const now = deps.now?.() ?? new Date();
  const account = await getBillingAccount(deps.db, orgId);
  if (!account || !hasPaidPlan(account) || !account.stripeSeatItemId) return null;
  const period = usagePeriod(account, now);
  const active = (await activeDevelopers(deps.db, orgId, period)).length;
  if (active <= account.seats) return null;
  await deps.stripe().updateSubscriptionItemQuantity(account.stripeSeatItemId, active, `openreview-seats-${orgId}-${seconds(period.start)}-${active}`);
  await deps.db
    .update(billingAccounts)
    .set({ seats: sql`greatest(${billingAccounts.seats}, ${active})` })
    .where(eq(billingAccounts.orgId, orgId));
  (deps.log ?? rootLog).info("subscription seats increased", { orgId, from: account.seats, to: active });
  return { from: account.seats, to: active };
}

/**
 * Overage reporting: credits used this period beyond the included credits (seats × per-seat allowance) are sent to
 * the overage price's billing meter. Only the delta since the last report is sent, and the event identifier is
 * derived from the period and the cumulative total, so re-running (or a retried job) never bills twice.
 */
export async function reportOverage(deps: BillingDeps, orgId: string): Promise<{ periodStart: Date; overage: number; reported: number }> {
  enabled(deps);
  const now = deps.now?.() ?? new Date();
  const account = await getBillingAccount(deps.db, orgId);
  const period = usagePeriod(account, now);
  if (!account?.stripeCustomerId || !hasPaidPlan(account)) return { periodStart: period.start, overage: 0, reported: 0 };
  const included = includedCredits(deps.cfg.plans.team, account.seats) ?? 0;
  const { credits } = await periodTotals(deps.db, orgId, period);
  const overage = Math.max(0, credits - included);
  const [row] = await deps.db
    .select({ reported: billingUsageReports.reportedCredits })
    .from(billingUsageReports)
    .where(and(eq(billingUsageReports.orgId, orgId), eq(billingUsageReports.periodStart, period.start)));
  const delta = overage - (row?.reported ?? 0);
  if (delta <= 0) return { periodStart: period.start, overage, reported: 0 };
  const stripe = deps.stripe();
  const eventName = await stripe.meterEventName(deps.cfg.stripe.overagePrice);
  await stripe.createMeterEvent({
    event_name: eventName,
    payload: { stripe_customer_id: account.stripeCustomerId, value: String(delta) },
    identifier: `openreview-overage-${orgId}-${seconds(period.start)}-${overage}`,
    timestamp: Math.min(seconds(now), seconds(period.end) - 1),
  });
  await deps.db
    .insert(billingUsageReports)
    .values({ orgId, periodStart: period.start, reportedCredits: overage })
    .onConflictDoUpdate({
      target: [billingUsageReports.orgId, billingUsageReports.periodStart],
      set: { reportedCredits: sql`greatest(${billingUsageReports.reportedCredits}, excluded.reported_credits)`, updatedAt: now },
    });
  (deps.log ?? rootLog).info("overage credits reported", { orgId, periodStart: period.start.toISOString(), overage, delta });
  return { periodStart: period.start, overage, reported: delta };
}

/** Seat sync and overage reporting for every org with a team subscription in force; one org's failure never stops the rest. */
export async function syncAllSubscriptions(deps: BillingDeps): Promise<{ orgs: number; failed: number }> {
  enabled(deps);
  const log = deps.log ?? rootLog;
  const accounts = (await deps.db.select().from(billingAccounts).where(eq(billingAccounts.plan, "team"))).filter((a) => !isSystemOrg(a.orgId));
  let failed = 0;
  let orgs = 0;
  for (const account of accounts.filter((a) => hasPaidPlan(a))) {
    orgs++;
    try {
      await syncSeats(deps, account.orgId);
      await reportOverage(deps, account.orgId);
    } catch (err) {
      failed++;
      log.warn("billing sync failed for an organization", { orgId: account.orgId, error: errorMessage(err) });
    }
  }
  return { orgs, failed };
}
