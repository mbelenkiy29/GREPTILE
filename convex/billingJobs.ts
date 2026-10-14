import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { creditConfig, stripe, stripeKey } from "../src/billing";

// Stripe Checkout / Customer Portal sessions for workspace admins, and seat-quantity sync.
const appOrigin = () => new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
export const checkout = action({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<string> => {
  const context = await ctx.runQuery(internal.billing.checkoutContext, a);
  if (context.subscriptionId && ["active", "trialing", "past_due"].includes(context.status)) throw new Error("This workspace already has a subscription; manage it in the billing portal");
  const key = stripeKey(), price = process.env.STRIPE_SEAT_PRICE_ID;
  if (!price || !/^price_[A-Za-z0-9]+$/.test(price)) throw new Error("Configure STRIPE_SEAT_PRICE_ID");
  let customer = context.customerId;
  if (!customer) {
    customer = (await stripe<{ id: string }>("/v1/customers", { metadata: { organizationId: a.organizationId } }, key, fetch, `customer:${a.organizationId}`)).id;
    await ctx.runMutation(internal.billing.linkCustomer, { organizationId: a.organizationId, customerId: customer });
  }
  const session = await stripe<{ url: string }>("/v1/checkout/sessions", { mode: "subscription", customer, client_reference_id: a.organizationId, line_items: [{ price, quantity: context.seats }], subscription_data: { metadata: { organizationId: a.organizationId } }, success_url: `${appOrigin()}/dashboard/settings/billing?checkout=success`, cancel_url: `${appOrigin()}/dashboard/settings/billing?checkout=cancelled` }, key);
  return session.url;
} });
export const portal = action({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<string> => {
  const context = await ctx.runQuery(internal.billing.checkoutContext, a);
  if (!context.customerId) throw new Error("Start a subscription first");
  return (await stripe<{ url: string }>("/v1/billing_portal/sessions", { customer: context.customerId, return_url: `${appOrigin()}/dashboard/settings/billing` }, stripeKey())).url;
} });
export const syncSeats = internalAction({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<string> => {
  const target = await ctx.runQuery(internal.billing.seatSyncTarget, a);
  if (!target || target.seats === target.billed) return "unchanged";
  await stripe(`/v1/subscriptions/${target.subscriptionId}`, { items: [{ id: target.itemId, quantity: target.seats }], proration_behavior: "create_prorations" }, stripeKey(), fetch, `seats:${target.subscriptionId}:${target.seats}:${target.billed}`);
  return "updated";
} });
// Overage credits → Stripe meter event (POST /v1/billing/meter_events). The row id is the event
// identifier, so a retried report is not counted twice by Stripe.
export const reportUsage = internalAction({ args: { id: v.id("billingMeterEvents") }, handler: async (ctx, a): Promise<string> => {
  const event = await ctx.runQuery(internal.billing.meterEvent, a);
  if (!event) return "done";
  if (!event.customerId) { await ctx.runMutation(internal.billing.meterResult, { id: a.id, status: "skipped", error: "No Stripe customer" }); return "skipped"; }
  try {
    await stripe("/v1/billing/meter_events", { event_name: creditConfig().meterEvent, identifier: a.id, timestamp: Math.floor(event.createdAt / 1000), payload: { stripe_customer_id: event.customerId, value: event.credits } }, stripeKey(), fetch, `meter:${a.id}`);
    await ctx.runMutation(internal.billing.meterResult, { id: a.id, status: "reported" });
    return "reported";
  } catch (error) {
    await ctx.runMutation(internal.billing.meterResult, { id: a.id, status: "retry", error: error instanceof Error ? error.message : "Stripe error" });
    return "retry";
  }
} });
// Credit packs: a one-time Stripe Checkout for STRIPE_CREDITS_PRICE_ID (one price unit = one credit).
// Credits are added when Stripe's signed checkout.session.completed event arrives, once per event.
export const buyCredits = action({ args: { token: v.string(), organizationId: v.id("organizations"), credits: v.number() }, handler: async (ctx, a): Promise<string> => {
  const context = await ctx.runQuery(internal.billing.checkoutContext, a);
  if (!Number.isInteger(a.credits) || a.credits < 10 || a.credits > 100_000) throw new Error("Buy between 10 and 100,000 credits");
  const key = stripeKey(), price = process.env.STRIPE_CREDITS_PRICE_ID;
  if (!price || !/^price_[A-Za-z0-9]+$/.test(price)) throw new Error("Configure STRIPE_CREDITS_PRICE_ID");
  let customer = context.customerId;
  if (!customer) {
    customer = (await stripe<{ id: string }>("/v1/customers", { metadata: { organizationId: a.organizationId } }, key, fetch, `customer:${a.organizationId}`)).id;
    await ctx.runMutation(internal.billing.linkCustomer, { organizationId: a.organizationId, customerId: customer });
  }
  const session = await stripe<{ url: string }>("/v1/checkout/sessions", { mode: "payment", customer, client_reference_id: a.organizationId, line_items: [{ price, quantity: a.credits }], metadata: { organizationId: a.organizationId, credits: String(a.credits) }, success_url: `${appOrigin()}/dashboard/settings/billing?credits=success`, cancel_url: `${appOrigin()}/dashboard/settings/billing?checkout=cancelled` }, key);
  return session.url;
} });
