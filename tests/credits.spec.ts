import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash, createHmac } from "node:crypto";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");
const whsec = "whsec_credits_fixture";
const env = { SESSION_SECRET: "credits-session-secret-at-least-32-characters", SERVICE_SECRET: "credits-service", BILLING_ENABLED: "true", BILLING_TRIAL_REVIEWS: "2", BILLING_REVIEWS_PER_SEAT: "2", BILLING_OVERAGE_CREDIT_USD: "0.5", STRIPE_WEBHOOK_SECRET: whsec, STRIPE_SECRET_KEY: "sk_test_fixture", APP_URL: "https://review.example.com" };
const extra = ["BILLING_FREE_CREDITS", "BILLING_TRIAL_DAYS"];
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 14, 12)); Object.assign(process.env, env); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const k of [...Object.keys(env), ...extra]) if (!["SESSION_SECRET", "SERVICE_SECRET"].includes(k)) delete process.env[k]; });

async function setup() {
  const t = convexTest(schema, modules);
  const login = async (githubId: number, name: string) => { const id = await t.mutation(api.users.login, { secret: "credits-service", githubId, login: name, avatar: "" }); return { id: id as Id<"users">, token: await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(id).setExpirationTime("1h").sign(new TextEncoder().encode(env.SESSION_SECRET)) }; };
  const alice = await login(41, "alice"), bob = await login(42, "bob");
  const org = await t.mutation(api.users.createOrganization, { token: alice.token, name: "Acme" });
  await t.mutation(api.repositories.connect, { token: alice.token, secret: "credits-service", organizationId: org, installationId: 41, account: "acme", accountId: 1, repositories: [{ id: 4101, fullName: "acme/shop", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token: alice.token, organizationId: org });
  await t.run((ctx) => ctx.db.patch(repo._id, { enabled: true }));
  return { t, alice, bob, org, repo };
}
const enqueue = (t: Awaited<ReturnType<typeof setup>>["t"], repositoryId: Id<"repositories">, pr: number) => t.mutation(internal.reviews.enqueue, { repositoryId, prNumber: pr, headSha: String(pr).padStart(40, "a"), trigger: "automatic" });
const outcome = async (t: Awaited<ReturnType<typeof setup>>["t"], repositoryId: Id<"repositories">, pr: number) => { const r = await t.run(async (ctx) => ctx.db.get((await enqueue(t, repositoryId, pr))!)); return r?.status === "failed" ? r.error : r?.status; };
const team = (t: Awaited<ReturnType<typeof setup>>["t"], org: Id<"organizations">) => t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId: org, customerId: "cus_1", subscriptionId: "sub_1", subscriptionItemId: "si_1", status: "active", seats: 1, trialEndsAt: Date.now() - 86_400_000, updatedAt: Date.now() }));
const signed = (event: Record<string, unknown>) => { const body = JSON.stringify(event), ts = Math.floor(Date.now() / 1000); return { body, headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${createHmac("sha256", whsec).update(`${ts}.${body}`).digest("hex")}` } }; };

test("spending cap: overage is metered to Stripe up to the cap, reviews pause with a note, admins are told once, and the next month resumes", async () => {
  const { t, alice, bob, org, repo } = await setup();
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: org, userId: bob.id, role: "member" }));
  await team(t, org);
  await t.run((ctx) => ctx.db.insert("notificationPreferences", { organizationId: org, userId: alice.id, email: "alice@example.com", emailVerifiedAt: 1, reviewCompleted: "off", highSeverity: "off", updatedAt: 1 }));
  const stripeCalls: { url: string; body: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => { stripeCalls.push({ url: String(url), body: String(init?.body ?? "") }); return Response.json({ object: "billing.meter_event" }); });
  // 1 seat × 2 credits; no cap → the third review is refused.
  expect(await outcome(t, repo._id, 1)).toBe("queued");
  expect(await outcome(t, repo._id, 2)).toBe("queued");
  expect(await outcome(t, repo._id, 3)).toMatch(/used its 2 credits .*set a spending cap/);
  // Only admins set the cap; it is audited.
  await expect(t.mutation(api.billing.setSpendingCap, { token: bob.token, organizationId: org, capUsd: 100 })).rejects.toThrow();
  await t.mutation(api.billing.setSpendingCap, { token: alice.token, organizationId: org, capUsd: 1 });
  // $0.50 per overage credit: two more reviews fit under $1.00, the next one pauses.
  expect(await outcome(t, repo._id, 4)).toBe("queued");
  expect(await outcome(t, repo._id, 5)).toBe("queued");
  expect(await outcome(t, repo._id, 6)).toMatch(/Billing: This workspace reached its monthly spending cap of \$1\.00/);
  expect(await outcome(t, repo._id, 7)).toMatch(/spending cap/);
  const status = await t.query(api.billing.status, { token: alice.token, organizationId: org });
  expect([status.enabled && status.allowed, status.enabled && status.credits.overageCredits, status.enabled && status.credits.overageUsd]).toEqual([false, 2, 1]);
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  // Two meter events, identified by their row ids, reported once each.
  const events = await t.run((ctx) => ctx.db.query("billingMeterEvents").collect());
  expect(events.map((e) => [e.credits, e.status])).toEqual([[1, "reported"], [1, "reported"]]);
  const meter = stripeCalls.filter((c) => c.url === "https://api.stripe.com/v1/billing/meter_events");
  expect(meter).toHaveLength(2);
  for (const [i, call] of meter.entries()) {
    const form = new URLSearchParams(call.body);
    expect([form.get("event_name"), form.get("identifier"), form.get("payload[stripe_customer_id]"), form.get("payload[value]")]).toEqual(["openreview_credits", events[i]._id, "cus_1", "1"]);
  }
  // 80% and 100% notices: once each per period, by email to verified admins (email delivery is not configured here, so it is recorded as skipped).
  const deliveries = (await t.run((ctx) => ctx.db.query("notificationDeliveries").collect())).map((d) => [d.key, d.status]).sort();
  expect(deliveries).toEqual([[`billing.cap:2026-10:100:email:${alice.id}`, "skipped"], [`billing.cap:2026-10:80:email:${alice.id}`, "skipped"]]);
  expect((await t.run((ctx) => ctx.db.query("billingUsage").collect()))[0].capNotices).toEqual([80, 100]);
  const audits = (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  expect(audits).toContain("billing.spending_cap");
  // A new billing month resumes with fresh included credits.
  vi.setSystemTime(Date.UTC(2026, 10, 1, 0, 0, 1));
  expect(await outcome(t, repo._id, 8)).toBe("queued");
});

test("meter events retry with the same identifier, and credit-pack webhooks add credits once even when replayed", async () => {
  const { t, alice, org, repo } = await setup();
  await team(t, org);
  await t.mutation(api.billing.setSpendingCap, { token: alice.token, organizationId: org, capUsd: 10 });
  const identifiers: string[] = [];
  let fail = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => { identifiers.push(new URLSearchParams(String(init?.body)).get("identifier")!); if (fail) { fail = false; return Response.json({ error: { type: "api_error" } }, { status: 500 }); } return Response.json({ object: "billing.meter_event" }); });
  for (const pr of [1, 2, 3]) await enqueue(t, repo._id, pr);
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const [event] = await t.run((ctx) => ctx.db.query("billingMeterEvents").collect());
  expect([event.status, event.attempts]).toEqual(["reported", 1]);
  expect(identifiers).toEqual([event._id, event._id]);
  // Credit packs: paid checkout sessions add credits once per Stripe event; unpaid ones add nothing.
  const pack = (id: string, payment: string) => ({ id, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { mode: "payment", payment_status: payment, client_reference_id: org, customer: "cus_1", metadata: { credits: "50" } } } });
  for (const e of [pack("evt_pack", "paid"), pack("evt_pack", "paid"), pack("evt_unpaid", "unpaid")]) { const { body, headers } = signed(e); expect((await t.fetch("/stripe/webhook", { method: "POST", headers, body })).status).toBe(200); }
  const account = (await t.run((ctx) => ctx.db.query("billingAccounts").collect()))[0];
  expect(account.extraCredits).toBe(50);
  expect((await t.run((ctx) => ctx.db.query("stripeEvents").collect())).map((e) => [e.eventId, e.outcome])).toEqual([["evt_pack", "credits added"], ["evt_unpaid", "ignored"]]);
});

test("free plan seat limit: one developer keeps reviewing after the trial; a second billed seat needs a subscription", async () => {
  process.env.BILLING_FREE_CREDITS = "3"; process.env.BILLING_TRIAL_DAYS = "0";
  const { t, bob, org, repo } = await setup();
  expect(await outcome(t, repo._id, 1)).toBe("queued");
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: org, userId: bob.id, role: "member" }));
  expect(await outcome(t, repo._id, 2)).toBe("Billing: The free plan covers 1 developer and this workspace has 2. Subscribe in Settings → Billing to keep reviewing.");
  await t.run(async (ctx) => { const m = await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", org).eq("userId", bob.id)).unique(); await ctx.db.patch(m!._id, { role: "viewer" }); });
  expect(await outcome(t, repo._id, 3)).toBe("queued");
});

test("generated tests cost extra credits when requested; without them the review goes on untested", async () => {
  const { t, alice, org, repo } = await setup();
  await team(t, org);
  const image = "node@sha256:" + "a".repeat(64), hash = createHash("sha256").update("orw_" + "c".repeat(64)).digest("hex");
  await t.mutation(api.runtime.save, { token: alice.token, organizationId: org, policy: { enabled: false, image, command: "", timeout: 60, requiredForApproval: false, generatedTests: true, testCommand: "node --test {test}" } });
  const workerId = await t.mutation(api.runtime.worker, { token: alice.token, organizationId: org, name: "isolated", hash });
  await t.run((ctx) => ctx.db.patch(workerId, { lastSeen: Date.now() }));
  const review = async (pr: number) => t.run((ctx) => ctx.db.insert("reviews", { organizationId: org, repositoryId: repo._id, prNumber: pr, headSha: "b".repeat(40), status: "summarizing", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() }));
  const tests = [{ fingerprint: "f1", path: "test/a.test.js", content: "test('x',()=>{})" }];
  const credits = async () => (await t.run((ctx) => ctx.db.query("billingUsage").collect()))[0]?.credits ?? 0;
  // 2 included credits: the tests (+2) fit once.
  expect(await t.mutation(internal.runtime.requestTests, { reviewId: await review(1), tests })).toBe(true);
  expect(await credits()).toBe(2);
  expect(await t.mutation(internal.runtime.requestTests, { reviewId: await review(2), tests })).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("runtimeJobs").collect())).toHaveLength(1);
});
