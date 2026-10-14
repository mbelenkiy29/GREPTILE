import { assertEgress } from "./egress";
// Cloud billing (Stripe). Disabled unless BILLING_ENABLED=true, which is the self-host default.
// A workspace starts on an app-level trial; a per-seat subscription sets a monthly review quota.
export type BillingConfig = { enabled: boolean; trialDays: number; trialReviews: number; reviewsPerSeat: number; graceDays: number };
const int = (value: string | undefined, fallback: number, min: number, max: number) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
export function billingConfig(env: Record<string, string | undefined> = process.env): BillingConfig {
  return { enabled: env.BILLING_ENABLED === "true", trialDays: int(env.BILLING_TRIAL_DAYS, 14, 0, 365), trialReviews: int(env.BILLING_TRIAL_REVIEWS, 200, 0, 1_000_000), reviewsPerSeat: int(env.BILLING_REVIEWS_PER_SEAT, 100, 1, 1_000_000), graceDays: int(env.BILLING_GRACE_DAYS, 7, 0, 60) };
}
// Billed seats: owners, admins and members; viewers are free.
export const seatCount = (members: { role: string }[]) => members.filter((m) => m.role !== "viewer").length;
export const periodKey = (now: number) => new Date(now).toISOString().slice(0, 7);

export type BillingAccount = { status: string; seats: number; trialEndsAt: number; pastDueSince?: number; subscriptionId?: string };
export type BillingDecision = { allowed: boolean; plan: "disabled" | "trial" | "team"; limit: number | null; used: number; reason?: string };
const paying = new Set(["active", "trialing", "past_due"]);
export function billingDecision(account: BillingAccount, used: number, now: number, config: BillingConfig): BillingDecision {
  if (!config.enabled) return { allowed: true, plan: "disabled", limit: null, used };
  if (account.subscriptionId && paying.has(account.status)) {
    const limit = Math.max(1, account.seats) * config.reviewsPerSeat;
    if (account.status === "past_due" && (account.pastDueSince ?? now) + config.graceDays * 86400000 <= now) return { allowed: false, plan: "team", limit, used, reason: "Payment is past due and the grace period has ended. Update the payment method in Settings → Billing." };
    if (used >= limit) return { allowed: false, plan: "team", limit, used, reason: `This workspace used its ${limit} reviews for this billing month. Add seats in Settings → Billing or wait for the next month.` };
    return { allowed: true, plan: "team", limit, used };
  }
  if (now >= account.trialEndsAt) return { allowed: false, plan: "trial", limit: config.trialReviews, used, reason: "The free trial has ended. Subscribe in Settings → Billing to keep reviewing." };
  if (used >= config.trialReviews) return { allowed: false, plan: "trial", limit: config.trialReviews, used, reason: `The trial includes ${config.trialReviews} reviews per month. Subscribe in Settings → Billing for more.` };
  return { allowed: true, plan: "trial", limit: config.trialReviews, used };
}

// Credits (M1). Every review spends credits; the defaults reproduce the review quota above (1 credit per
// review, credits per seat = reviews per seat, trial credits = trial reviews). A generated-test review
// costs more in total; the difference is charged when the tests job is requested. Extra credits are bought
// as packs and used after the included ones. Team workspaces may allow metered overage up to a monthly
// dollar cap they set. A free plan for small workspaces is off until BILLING_FREE_CREDITS is set.
export type CreditConfig = { perReview: number; perGeneratedTestReview: number; perSeat: number; trial: number; freeSeats: number; free: number; overageUsd: number; meterEvent: string };
const money = (value: string | undefined, fallback: number) => { const n = Number(value); return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 && n <= 1000 ? n : fallback; };
export function creditConfig(env: Record<string, string | undefined> = process.env): CreditConfig {
  const base = billingConfig(env);
  return {
    perReview: int(env.BILLING_CREDITS_REVIEW, 1, 0, 1000), perGeneratedTestReview: int(env.BILLING_CREDITS_GENERATED_TESTS, 3, 0, 1000),
    perSeat: int(env.BILLING_CREDITS_PER_SEAT, base.reviewsPerSeat, 1, 1_000_000), trial: int(env.BILLING_TRIAL_CREDITS, base.trialReviews, 0, 1_000_000),
    freeSeats: int(env.BILLING_FREE_SEATS, 1, 0, 100), free: int(env.BILLING_FREE_CREDITS, 0, 0, 1_000_000),
    overageUsd: money(env.BILLING_OVERAGE_CREDIT_USD, 0.5), meterEvent: /^[a-z0-9_]{1,100}$/.test(env.STRIPE_METER_EVENT ?? "") ? env.STRIPE_METER_EVENT! : "openreview_credits",
  };
}
export type CreditKind = "review" | "generated-tests";
export const creditCost = (kind: CreditKind, c: CreditConfig) => kind === "review" ? c.perReview : Math.max(0, c.perGeneratedTestReview - c.perReview);
export type CreditAccount = BillingAccount & { billedSeats: number; extraCredits?: number; spendCapUsd?: number };
export type CreditUsage = { credits: number; overageCredits: number };
export type CreditDecision = { allowed: boolean; plan: "disabled" | "trial" | "free" | "team"; source?: "included" | "extra" | "overage"; included: number | null; used: number; extra: number; overageUsd: number; capUsd: number; reason?: string };
const usd = (n: number) => `$${n.toFixed(2)}`;
export function creditDecision(account: CreditAccount, usage: CreditUsage, cost: number, now: number, config: BillingConfig, credits: CreditConfig): CreditDecision {
  const extra = Math.max(0, account.extraCredits ?? 0), capUsd = Math.max(0, account.spendCapUsd ?? 0), overageUsd = usage.overageCredits * credits.overageUsd;
  const base = { used: usage.credits, extra, overageUsd, capUsd };
  if (!config.enabled) return { allowed: true, plan: "disabled", included: null, ...base };
  let plan: "trial" | "free" | "team", included: number;
  if (account.subscriptionId && paying.has(account.status)) {
    plan = "team"; included = Math.max(1, account.seats) * credits.perSeat;
    if (account.status === "past_due" && (account.pastDueSince ?? now) + config.graceDays * 86400000 <= now) return { allowed: false, plan, included, ...base, reason: "Payment is past due and the grace period has ended. Update the payment method in Settings → Billing." };
  } else if (now < account.trialEndsAt) { plan = "trial"; included = credits.trial; }
  else if (credits.free > 0 && account.billedSeats <= credits.freeSeats) { plan = "free"; included = credits.free; }
  else return { allowed: false, plan: credits.free > 0 ? "free" : "trial", included: credits.free > 0 ? credits.free : credits.trial, ...base, reason: credits.free > 0 ? `The free plan covers ${credits.freeSeats} developer${credits.freeSeats === 1 ? "" : "s"} and this workspace has ${account.billedSeats}. Subscribe in Settings → Billing to keep reviewing.` : "The free trial has ended. Subscribe in Settings → Billing to keep reviewing." };
  if (usage.credits + cost <= included) return { allowed: true, plan, source: "included", included, ...base };
  if (extra >= cost) return { allowed: true, plan, source: "extra", included, ...base };
  if (plan === "team" && capUsd > 0) {
    if ((usage.overageCredits + cost) * credits.overageUsd <= capUsd + 1e-9) return { allowed: true, plan, source: "overage", included, ...base };
    return { allowed: false, plan, included, ...base, reason: `This workspace reached its monthly spending cap of ${usd(capUsd)}. Reviews resume next month, or an admin can raise the cap in Settings → Billing.` };
  }
  const word = `${included} credits`;
  return { allowed: false, plan, included, ...base, reason: plan === "team" ? `This workspace used its ${word} for this billing month. Add seats, buy credits or set a spending cap in Settings → Billing.` : plan === "trial" ? `The trial includes ${word} per month. Subscribe in Settings → Billing for more.` : `The free plan includes ${word} per month. Subscribe or buy credits in Settings → Billing for more.` };
}
// Spending-cap notices fire once per period for each threshold (80%, 100%) the overage spend has reached;
// a review refused by the cap counts as having reached 100%.
export function capThresholds(spentUsd: number, capUsd: number, alreadySent: number[] = []) {
  if (capUsd <= 0) return [];
  return [80, 100].filter((p) => !alreadySent.includes(p) && spentUsd + 1e-9 >= (capUsd * p) / 100);
}

// Stripe webhook signatures: "t=<unix>,v1=<hex>[,v1=...]" over `${t}.${payload}` (HMAC-SHA256).
const encoder = new TextEncoder();
export async function verifyStripeSignature(payload: string, header: string | null, secret: string | undefined, now = Date.now(), toleranceSeconds = 300) {
  if (!secret || !header || header.length > 2000) return false;
  const parts = header.split(",").map((p) => p.split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k, v]) => k === "v1" && /^[a-f0-9]{64}$/.test(v ?? "")).map(([, v]) => v);
  if (!t || !/^\d{1,12}$/.test(t) || !signatures.length || Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`)));
  return signatures.some((signature) => { const provided = signature.match(/../g)!.map((b) => parseInt(b, 16)); let d = 0; for (let i = 0; i < mac.length; i++) d |= mac[i] ^ provided[i]; return d === 0; });
}

// Minimal Stripe REST client (form-encoded). Live keys are refused unless BILLING_ALLOW_LIVE=true.
export function stripeKey(env: Record<string, string | undefined> = process.env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Configure STRIPE_SECRET_KEY");
  if (!key.startsWith("sk_test_") && !(key.startsWith("sk_live_") && env.BILLING_ALLOW_LIVE === "true")) throw new Error("Use a Stripe test-mode key (sk_test_…), or set BILLING_ALLOW_LIVE=true for live mode");
  return key;
}
export function formEncode(params: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(params).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v.flatMap((item, i) => typeof item === "object" ? formEncode(item as Record<string, unknown>, `${key}[${i}]`) : [`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`]);
    if (typeof v === "object") return formEncode(v as Record<string, unknown>, key);
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`];
  });
}
export async function stripe<T>(path: string, params: Record<string, unknown>, key: string, fetchImpl: typeof fetch = fetch, idempotencyKey?: string): Promise<T> {
  if (!/^\/v1\/[a-z_/]+[a-zA-Z0-9_/]*$/.test(path)) throw new Error("Invalid Stripe API path");
  assertEgress("billing", "Stripe billing");
  const response = await fetchImpl("https://api.stripe.com" + path, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: formEncode(params).join("&"), signal: AbortSignal.timeout(20000) });
  const data = (await response.json().catch(() => null)) as T & { error?: { type?: string } } | null;
  if (!response.ok || !data) throw new Error(`Stripe request failed (${response.status}${data?.error?.type ? ` ${data.error.type}` : ""})`);
  return data;
}
