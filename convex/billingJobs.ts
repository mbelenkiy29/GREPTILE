import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { stripe, stripeKey } from "../src/billing";

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
