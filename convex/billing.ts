import { internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { authorize } from "./auth";
import { billingConfig, billingDecision, periodKey, seatCount, trialEndsFrom } from "../src/billing";

// Billing state and the review quota gate. With BILLING_ENABLED unset every check allows.
// The account row (and with it the trial clock) starts with the first review or checkout, so
// workspaces created before billing was turned on still get their full trial.
async function members(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).collect();
}
async function accountOf(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).unique();
}
async function ensureAccount(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<Doc<"billingAccounts">> {
  const existing = await accountOf(ctx, organizationId);
  if (existing) return existing;
  const id = await ctx.db.insert("billingAccounts", { organizationId, status: "trial", seats: seatCount(await members(ctx, organizationId)), trialEndsAt: trialEndsFrom(Date.now(), billingConfig()), updatedAt: Date.now() });
  return (await ctx.db.get(id))!;
}
async function usageOf(ctx: QueryCtx, organizationId: Id<"organizations">, period: string) {
  return ctx.db.query("billingUsage").withIndex("by_org_period", (q) => q.eq("organizationId", organizationId).eq("period", period)).unique();
}
// Called by reviews.enqueue: counts an allowed review, or records a blocked one with its reason.
export async function reviewAllowance(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const config = billingConfig();
  if (!config.enabled) return { allowed: true };
  const account = await ensureAccount(ctx, organizationId), now = Date.now(), period = periodKey(now);
  const usage = await usageOf(ctx, organizationId, period);
  const decision = billingDecision(account, usage?.reviews ?? 0, now, config);
  if (usage) await ctx.db.patch(usage._id, decision.allowed ? { reviews: usage.reviews + 1 } : { blocked: usage.blocked + 1 });
  else await ctx.db.insert("billingUsage", { organizationId, period, reviews: decision.allowed ? 1 : 0, blocked: decision.allowed ? 0 : 1 });
  return decision.allowed ? { allowed: true } : { allowed: false, reason: "Billing: " + decision.reason };
}

export const status = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { member } = await authorize(ctx, a.token, a.organizationId);
  const config = billingConfig();
  if (!config.enabled) return { enabled: false as const };
  const stored = await accountOf(ctx, a.organizationId);
  const account = stored ?? { status: "trial", seats: 0, trialEndsAt: trialEndsFrom(Date.now(), config) } as Pick<Doc<"billingAccounts">, "status" | "seats" | "trialEndsAt"> & Partial<Doc<"billingAccounts">>;
  const usage = await usageOf(ctx, a.organizationId, periodKey(Date.now()));
  const decision = billingDecision({ status: account.status, seats: account.seats, trialEndsAt: account.trialEndsAt, pastDueSince: account.pastDueSince, subscriptionId: account.subscriptionId }, usage?.reviews ?? 0, Date.now(), config);
  return { enabled: true as const, admin: ["owner", "admin"].includes(member.role), status: account.status, plan: decision.plan, allowed: decision.allowed, reason: decision.reason ?? null, limit: decision.limit, used: decision.used, blocked: usage?.blocked ?? 0, activeSeats: seatCount(await members(ctx, a.organizationId)), billedSeats: account.subscriptionId ? account.seats : null, trialEndsAt: account.trialEndsAt, trialStarted: Boolean(stored), trialDays: config.trialDays, trialReviews: config.trialReviews, currentPeriodEnd: account.currentPeriodEnd ?? null, pastDueSince: account.pastDueSince ?? null, graceDays: config.graceDays, reviewsPerSeat: config.reviewsPerSeat, hasCustomer: Boolean(account.customerId) };
} });

export const checkoutContext = internalQuery({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  if (!billingConfig().enabled) throw new Error("Billing is disabled on this deployment");
  const account = await accountOf(ctx, a.organizationId);
  return { customerId: account?.customerId ?? null, subscriptionId: account?.subscriptionId ?? null, status: account?.status ?? "trial", trialEndsAt: account?.trialEndsAt ?? trialEndsFrom(Date.now(), billingConfig()), seats: Math.max(1, seatCount(await members(ctx, a.organizationId))) };
} });
export const linkCustomer = internalMutation({ args: { organizationId: v.id("organizations"), customerId: v.string() }, handler: async (ctx, a) => {
  const account = await ensureAccount(ctx, a.organizationId);
  if (account.customerId && account.customerId !== a.customerId) throw new Error("Workspace already has a billing customer");
  const other = await ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", a.customerId)).unique();
  if (other && other._id !== account._id) throw new Error("Billing customer belongs to another workspace");
  await ctx.db.patch(account._id, { customerId: a.customerId, updatedAt: Date.now() });
} });

const subscriptionArgs = v.object({ id: v.string(), customer: v.string(), status: v.string(), quantity: v.number(), itemId: v.optional(v.string()), currentPeriodEnd: v.optional(v.number()), organizationId: v.optional(v.string()) });
// Signed Stripe events, applied at most once; subscription events older than the last applied
// one are recorded but ignored, so redelivery and reordering cannot roll state back.
export const applyStripeEvent = internalMutation({ args: { eventId: v.string(), type: v.string(), created: v.number(), checkout: v.optional(v.object({ organizationId: v.string(), customer: v.string(), subscription: v.optional(v.string()) })), subscription: v.optional(subscriptionArgs), invoice: v.optional(v.object({ customer: v.string(), subscription: v.optional(v.string()) })) }, handler: async (ctx, a): Promise<string> => {
  if (await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", a.eventId)).unique()) return "duplicate";
  const record = async (outcome: string) => { await ctx.db.insert("stripeEvents", { eventId: a.eventId, type: a.type.slice(0, 100), outcome, createdAt: Date.now() }); return outcome; };
  const byCustomer = (customer: string) => ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", customer)).unique();
  if (a.checkout) {
    const organizationId = ctx.db.normalizeId("organizations", a.checkout.organizationId);
    if (!organizationId || !await ctx.db.get(organizationId)) return record("unknown workspace");
    const account = await ensureAccount(ctx, organizationId);
    if (account.customerId && account.customerId !== a.checkout.customer) return record("customer mismatch");
    await ctx.db.patch(account._id, { customerId: a.checkout.customer, ...(a.checkout.subscription ? { subscriptionId: a.checkout.subscription } : {}), updatedAt: Date.now() });
    return record("linked");
  }
  if (a.subscription) {
    const s = a.subscription;
    const account = await byCustomer(s.customer);
    if (!account) return record("unknown customer");
    if (s.organizationId && s.organizationId !== account.organizationId) return record("workspace mismatch");
    if (account.lastEventCreated && a.created < account.lastEventCreated) return record("stale");
    const deleted = a.type === "customer.subscription.deleted";
    await ctx.db.patch(account._id, { subscriptionId: s.id, subscriptionItemId: s.itemId, status: deleted ? "canceled" : s.status, seats: s.quantity, currentPeriodEnd: s.currentPeriodEnd, pastDueSince: s.status === "past_due" ? account.pastDueSince ?? a.created : undefined, lastEventCreated: a.created, updatedAt: Date.now() });
    return record(deleted ? "canceled" : s.status);
  }
  if (a.invoice) {
    const account = await byCustomer(a.invoice.customer);
    if (!account || (a.invoice.subscription && account.subscriptionId && a.invoice.subscription !== account.subscriptionId)) return record("unknown customer");
    if (a.type === "invoice.payment_failed") await ctx.db.patch(account._id, { status: "past_due", pastDueSince: account.pastDueSince ?? a.created, updatedAt: Date.now() });
    if (a.type === "invoice.paid" && account.status === "past_due") await ctx.db.patch(account._id, { status: "active", pastDueSince: undefined, updatedAt: Date.now() });
    return record(a.type);
  }
  return record("ignored");
} });

// Seat changes resync the subscription quantity (only for active subscriptions).
export async function scheduleSeatSync(ctx: MutationCtx, organizationId: Id<"organizations">) {
  if (!billingConfig().enabled) return;
  const account = await accountOf(ctx, organizationId);
  if (account?.subscriptionId && account.subscriptionItemId && ["active", "trialing", "past_due"].includes(account.status)) await ctx.scheduler.runAfter(0, internal.billingJobs.syncSeats, { organizationId });
}
export const seatSyncTarget = internalQuery({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const account = await accountOf(ctx, a.organizationId);
  if (!account?.subscriptionId || !account.subscriptionItemId) return null;
  return { subscriptionId: account.subscriptionId, itemId: account.subscriptionItemId, billed: account.seats, seats: Math.max(1, seatCount(await members(ctx, a.organizationId))) };
} });
