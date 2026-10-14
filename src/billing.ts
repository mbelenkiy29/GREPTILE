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
  const response = await fetchImpl("https://api.stripe.com" + path, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: formEncode(params).join("&"), signal: AbortSignal.timeout(20000) });
  const data = (await response.json().catch(() => null)) as T & { error?: { type?: string } } | null;
  if (!response.ok || !data) throw new Error(`Stripe request failed (${response.status}${data?.error?.type ? ` ${data.error.type}` : ""})`);
  return data;
}
