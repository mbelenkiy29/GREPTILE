import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { audit, authorize } from "./auth";
import { billingConfig, capThresholds, creditConfig, creditCost, creditDecision, periodKey, seatCount, type CreditKind } from "../src/billing";

// Billing state and the review quota gate. With BILLING_ENABLED unset every check allows.
async function members(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).collect();
}
async function accountOf(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).unique();
}
async function ensureAccount(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<Doc<"billingAccounts">> {
  const existing = await accountOf(ctx, organizationId);
  if (existing) return existing;
  const organization = await ctx.db.get(organizationId);
  const id = await ctx.db.insert("billingAccounts", { organizationId, status: "trial", seats: seatCount(await members(ctx, organizationId)), trialEndsAt: (organization?.createdAt ?? Date.now()) + billingConfig().trialDays * 86400000, updatedAt: Date.now() });
  return (await ctx.db.get(id))!;
}
async function usageOf(ctx: QueryCtx, organizationId: Id<"organizations">, period: string) {
  return ctx.db.query("billingUsage").withIndex("by_org_period", (q) => q.eq("organizationId", organizationId).eq("period", period)).unique();
}
// Spends credits for a review (at enqueue) or for generated tests (when the tests job is requested).
// Included credits first, then purchased ones, then capped overage (team plan) metered to Stripe.
export async function chargeCredits(ctx: MutationCtx, organizationId: Id<"organizations">, kind: CreditKind): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const config = billingConfig(), credits = creditConfig();
  if (!config.enabled) return { allowed: true };
  const account = await ensureAccount(ctx, organizationId), now = Date.now(), period = periodKey(now), cost = creditCost(kind, credits);
  const usage = await usageOf(ctx, organizationId, period);
  const used = { credits: usage?.credits ?? usage?.reviews ?? 0, overageCredits: usage?.overageCredits ?? 0 };
  const billedSeats = seatCount(await members(ctx, organizationId));
  const decision = creditDecision({ ...account, billedSeats }, used, cost, now, config, credits);
  const next = { credits: used.credits + (decision.source === "included" ? cost : 0), overageCredits: used.overageCredits + (decision.source === "overage" ? cost : 0) };
  const counts = kind === "review" ? (decision.allowed ? { reviews: (usage?.reviews ?? 0) + 1 } : { blocked: (usage?.blocked ?? 0) + 1 }) : {};
  // Cap notices: crossing 80% / 100% of the cap with overage, or being refused by it.
  const capUsd = account.spendCapUsd ?? 0;
  const spent = decision.allowed ? next.overageCredits * credits.overageUsd : /spending cap/.test(decision.reason ?? "") ? capUsd : 0;
  const notices = capThresholds(spent, capUsd, usage?.capNotices ?? []);
  const data = { ...next, ...counts, ...(notices.length ? { capNotices: [...(usage?.capNotices ?? []), ...notices] } : {}) };
  if (usage) await ctx.db.patch(usage._id, data);
  else await ctx.db.insert("billingUsage", { organizationId, period, reviews: 0, blocked: 0, ...data });
  if (decision.source === "extra") await ctx.db.patch(account._id, { extraCredits: Math.max(0, (account.extraCredits ?? 0) - cost), updatedAt: now });
  if (decision.source === "overage" && cost > 0) {
    const id = await ctx.db.insert("billingMeterEvents", { organizationId, period, credits: cost, status: "pending", attempts: 0, createdAt: now });
    await ctx.scheduler.runAfter(0, internal.billingJobs.reportUsage, { id });
  }
  for (const percent of notices) await ctx.scheduler.runAfter(0, internal.notificationJobs.billingCapNotice, { organizationId, period, percent, capUsd });
  return decision.allowed ? { allowed: true } : { allowed: false, reason: "Billing: " + decision.reason };
}
// Called by reviews.enqueue: counts an allowed review, or records a blocked one with its reason.
export const reviewAllowance = (ctx: MutationCtx, organizationId: Id<"organizations">) => chargeCredits(ctx, organizationId, "review");

// Admin-set monthly overage cap in dollars (0 turns overage off). Audited.
export const setSpendingCap = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), capUsd: v.number() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  if (!billingConfig().enabled) throw new Error("Billing is disabled on this deployment");
  if (!Number.isFinite(a.capUsd) || a.capUsd < 0 || a.capUsd > 1_000_000) throw new Error("Enter a cap between $0 and $1,000,000");
  const account = await ensureAccount(ctx, a.organizationId);
  await ctx.db.patch(account._id, { spendCapUsd: Math.round(a.capUsd * 100) / 100, updatedAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, "billing.spending_cap", String(Math.round(a.capUsd * 100) / 100));
} });
// Who hears about the cap: workspace admins with a verified notification email, and linked Slack channels.
export const capNoticeTargets = internalQuery({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const admins = new Set((await members(ctx, a.organizationId)).filter((m) => ["owner", "admin"].includes(m.role)).map((m) => m.userId as string));
  const emails = (await ctx.db.query("notificationPreferences").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(1000)).filter((p) => p.email && p.emailVerifiedAt && admins.has(p.userId)).map((p) => ({ userId: p.userId, email: p.email! }));
  const slack = (await ctx.db.query("slackInstallations").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(10)).find((i) => i.active);
  const channels = slack ? (await ctx.db.query("notificationChannels").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(100)).filter((c) => c.installationId === slack._id).map((c) => c.channelId) : [];
  return { emails, installationId: slack?._id ?? null, channels };
} });
export const meterEvent = internalQuery({ args: { id: v.id("billingMeterEvents") }, handler: async (ctx, a) => {
  const event = await ctx.db.get(a.id);
  if (!event || event.status !== "pending") return null;
  const account = await accountOf(ctx, event.organizationId);
  return { ...event, customerId: account?.customerId ?? null };
} });
export const meterResult = internalMutation({ args: { id: v.id("billingMeterEvents"), status: v.union(v.literal("reported"), v.literal("skipped"), v.literal("retry")), error: v.optional(v.string()) }, handler: async (ctx, a) => {
  const event = await ctx.db.get(a.id);
  if (!event || event.status !== "pending") return;
  if (a.status === "retry") {
    const attempts = event.attempts + 1;
    if (attempts >= 5) { await ctx.db.patch(event._id, { status: "failed", attempts, error: a.error?.slice(0, 300) }); return; }
    await ctx.db.patch(event._id, { attempts, error: a.error?.slice(0, 300) });
    await ctx.scheduler.runAfter(60_000 * 2 ** attempts, internal.billingJobs.reportUsage, { id: event._id });
    return;
  }
  await ctx.db.patch(event._id, { status: a.status, ...(a.status === "reported" ? { reportedAt: Date.now() } : {}), ...(a.error ? { error: a.error.slice(0, 300) } : {}) });
} });

export const status = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { member } = await authorize(ctx, a.token, a.organizationId);
  const config = billingConfig();
  if (!config.enabled) return { enabled: false as const };
  const organization = await ctx.db.get(a.organizationId);
  const account = await accountOf(ctx, a.organizationId) ?? { status: "trial", seats: 0, trialEndsAt: (organization?.createdAt ?? Date.now()) + config.trialDays * 86400000 } as Pick<Doc<"billingAccounts">, "status" | "seats" | "trialEndsAt"> & Partial<Doc<"billingAccounts">>;
  const usage = await usageOf(ctx, a.organizationId, periodKey(Date.now()));
  const credits = creditConfig(), billedSeats = seatCount(await members(ctx, a.organizationId));
  const decision = creditDecision({ status: account.status, seats: account.seats, trialEndsAt: account.trialEndsAt, pastDueSince: account.pastDueSince, subscriptionId: account.subscriptionId, billedSeats, extraCredits: account.extraCredits, spendCapUsd: account.spendCapUsd }, { credits: usage?.credits ?? usage?.reviews ?? 0, overageCredits: usage?.overageCredits ?? 0 }, credits.perReview, Date.now(), config, credits);
  return { enabled: true as const, admin: ["owner", "admin"].includes(member.role), status: account.status, plan: decision.plan, allowed: decision.allowed, reason: decision.reason ?? null, limit: decision.included, used: decision.used, credits: { perReview: credits.perReview, perGeneratedTestReview: credits.perGeneratedTestReview, perSeat: credits.perSeat, extra: decision.extra, overageCredits: usage?.overageCredits ?? 0, overageUsd: decision.overageUsd, capUsd: decision.capUsd, creditUsd: credits.overageUsd, free: credits.free, freeSeats: credits.freeSeats, packs: Boolean(process.env.STRIPE_CREDITS_PRICE_ID) }, blocked: usage?.blocked ?? 0, activeSeats: seatCount(await members(ctx, a.organizationId)), billedSeats: account.subscriptionId ? account.seats : null, trialEndsAt: account.trialEndsAt, currentPeriodEnd: account.currentPeriodEnd ?? null, pastDueSince: account.pastDueSince ?? null, graceDays: config.graceDays, reviewsPerSeat: config.reviewsPerSeat, hasCustomer: Boolean(account.customerId) };
} });

export const checkoutContext = internalQuery({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  if (!billingConfig().enabled) throw new Error("Billing is disabled on this deployment");
  const account = await accountOf(ctx, a.organizationId);
  return { customerId: account?.customerId ?? null, subscriptionId: account?.subscriptionId ?? null, status: account?.status ?? "trial", seats: Math.max(1, seatCount(await members(ctx, a.organizationId))) };
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
export const applyStripeEvent = internalMutation({ args: { eventId: v.string(), type: v.string(), created: v.number(), checkout: v.optional(v.object({ organizationId: v.string(), customer: v.string(), subscription: v.optional(v.string()) })), credits: v.optional(v.object({ organizationId: v.string(), customer: v.string(), credits: v.number() })), subscription: v.optional(subscriptionArgs), invoice: v.optional(v.object({ customer: v.string(), subscription: v.optional(v.string()) })) }, handler: async (ctx, a): Promise<string> => {
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
  // Credit pack paid: add the credits once (the event id above makes replays no-ops).
  if (a.credits) {
    const organizationId = ctx.db.normalizeId("organizations", a.credits.organizationId);
    if (!organizationId || !await ctx.db.get(organizationId)) return record("unknown workspace");
    if (!Number.isInteger(a.credits.credits) || a.credits.credits <= 0 || a.credits.credits > 100_000) return record("invalid credits");
    const account = await ensureAccount(ctx, organizationId);
    if (account.customerId && account.customerId !== a.credits.customer) return record("customer mismatch");
    await ctx.db.patch(account._id, { customerId: a.credits.customer, extraCredits: (account.extraCredits ?? 0) + a.credits.credits, updatedAt: Date.now() });
    return record("credits added");
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
