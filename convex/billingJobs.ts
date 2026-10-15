import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { checkoutTrialEnd, stripe, stripeKey } from "../src/billing";

// Stripe Checkout / Customer Portal sessions for workspace admins, and seat-quantity sync.
const appOrigin = () => new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const returnPaths = { settings: "/dashboard/settings/billing", onboarding: "/dashboard/onboarding/plan" } as const;
// Tags these sessions in the Stripe Dashboard so this flow can be compared with others.
const integrationIdentifier = "openreview-starter-seats-qkvmhzrt";
export const checkout = action({ args: { token: v.string(), organizationId: v.id("organizations"), returnTo: v.optional(v.union(v.literal("settings"), v.literal("onboarding"))) }, handler: async (ctx, a): Promise<string> => {
  const context = await ctx.runQuery(internal.billing.checkoutContext, { token: a.token, organizationId: a.organizationId });
  if (context.subscriptionId && ["active", "trialing", "past_due"].includes(context.status)) throw new Error("This workspace already has a subscription; manage it in the billing portal");
  const key = stripeKey(), price = process.env.STRIPE_SEAT_PRICE_ID;
  if (!price || !/^price_[A-Za-z0-9]+$/.test(price)) throw new Error("Configure STRIPE_SEAT_PRICE_ID");
  let customer = context.customerId;
  if (!customer) {
    customer = (await stripe<{ id: string }>("/v1/customers", { metadata: { organizationId: a.organizationId } }, key, fetch, `customer:${a.organizationId}`)).id;
    await ctx.runMutation(internal.billing.linkCustomer, { organizationId: a.organizationId, customerId: customer });
  }
  // The card is collected now; any remaining trial carries over, so the first charge waits for it.
  const back = appOrigin() + returnPaths[a.returnTo ?? "settings"], trialEnd = checkoutTrialEnd(context.trialEndsAt, Date.now());
  const session = await stripe<{ url: string }>("/v1/checkout/sessions", { mode: "subscription", customer, client_reference_id: a.organizationId, integration_identifier: integrationIdentifier, line_items: [{ price, quantity: context.seats }], subscription_data: { metadata: { organizationId: a.organizationId }, ...(trialEnd ? { trial_end: trialEnd } : {}) }, success_url: `${back}?checkout=success`, cancel_url: `${back}?checkout=cancelled` }, key);
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
