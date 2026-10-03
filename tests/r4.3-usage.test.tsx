import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { UsageBanners } from "@/components/usage/UsageBanners";
import { UsageView } from "@/components/usage/UsageView";
import { checkUsageAlerts, signAlertPayload, usageBanners, usageStatus } from "@/lib/billing/alerts";
import { checkUsageLimits, UsageLimitError } from "@/lib/billing/limits";
import { LIMIT_NOTICE_MARKER } from "@/lib/billing/notices";
import { billingConfig } from "@/lib/billing/plans";
import { billingEnv } from "@/lib/env";
import { assertPublicWebhookUrl, getAlertSecret, getUsageSettings, parseUsageSettingsForm, saveUsageSettings, UsageSettingsError } from "@/lib/billing/settings";
import { completeInstallation } from "@/lib/data/installations";
import { requestManualReview } from "@/lib/data/onboarding";
import {
  csvCell,
  loadUsagePage,
  resolveUsageRange,
  usageByAuthor,
  usageByKind,
  usageByModel,
  usageByRepo,
  usageByTask,
  usageCsv,
  usageDaily,
  usageSummary,
} from "@/lib/data/usage";
import { createUsageExportHandler } from "@/lib/data/usage-export";
import type { Db } from "@/lib/db";
import { modelCalls, orgs, reviewRuns, reviews, usageAlerts, usageEvents } from "@/lib/db/schema";
import { MemoryQueue } from "@/lib/jobs/types";
import { requestReview } from "@/lib/pipeline/request";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { apiDeps, call, json, makeKey } from "./helpers/api";
import { NOW, TEST_SECRET, testAuthConfig, userWithOrg } from "./helpers/auth";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";

let db: Db;
/** Billing configuration without Stripe (self-hosted). */
const off = billingConfig(billingEnv({ APP_URL: "https://review.example.com" }));

const at = (iso: string) => new Date(iso);

async function seedOrg(id: string, name = id) {
  await db.insert(orgs).values({ id, name }).onConflictDoNothing();
}

async function event(orgId: string, v: Partial<typeof usageEvents.$inferInsert> & { createdAt: Date }) {
  await db.insert(usageEvents).values({ orgId, kind: "review", ...v });
}

async function call_(orgId: string, v: Partial<typeof modelCalls.$inferInsert> & { createdAt: Date }) {
  await db.insert(modelCalls).values({ orgId, task: "review", provider: "anthropic", model: "claude-x", status: "ok", ...v });
}

beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("APP_SECRET", TEST_SECRET);
});

describe("usage analytics (R4.3)", () => {
  test("R4.3 aggregates credits, tokens, and cost per repository, author, day, model, task, and kind, scoped to the org and the period", async () => {
    const host = new FakeGitHost();
    host.addInstallation(11, "acme", [
      { id: 1, fullName: "acme/api", defaultBranch: "main", private: true },
      { id: 2, fullName: "acme/web", defaultBranch: "main", private: true },
    ]);
    const { repos } = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
    const api = repos.find((r) => r.fullName === "acme/api")!;
    const web = repos.find((r) => r.fullName === "acme/web")!;
    await seedOrg("org_b");
    // In October 2026 (the period), plus noise before, after, and in another org.
    await event("org_a", { repoId: api.id, author: "alice", credits: 2, inputTokens: 1000, outputTokens: 100, costUsd: 0.01, createdAt: at("2026-10-01T00:00:00Z") });
    await event("org_a", { repoId: api.id, author: "bob", credits: 4, inputTokens: 3000, outputTokens: 300, costUsd: 0.05, createdAt: at("2026-10-02T10:00:00Z") });
    await event("org_a", { repoId: web.id, author: "alice", credits: 1, inputTokens: 500, outputTokens: 50, costUsd: 0.002, createdAt: at("2026-10-02T23:59:59Z") });
    await event("org_a", { kind: "chat", repoId: web.id, author: "carol", credits: 0, inputTokens: 200, outputTokens: 20, costUsd: 0.001, createdAt: at("2026-10-03T08:00:00Z") });
    await event("org_a", { repoId: api.id, author: "alice", credits: 9, createdAt: at("2026-09-30T23:59:59Z") });
    await event("org_a", { repoId: api.id, author: "alice", credits: 9, createdAt: at("2026-11-01T00:00:00Z") });
    await event("org_b", { author: "mallory", credits: 99, inputTokens: 9, costUsd: 9, createdAt: at("2026-10-02T00:00:00Z") });
    await call_("org_a", { model: "claude-x", task: "review", inputTokens: 1000, outputTokens: 100, costUsd: 0.04, reviewRunId: null, createdAt: at("2026-10-01T01:00:00Z") });
    await call_("org_a", { model: "claude-y", task: "verify", inputTokens: 300, outputTokens: 30, costUsd: 0.01, createdAt: at("2026-10-02T01:00:00Z") });
    await call_("org_a", { provider: "openai", model: "embed-small", task: "embed", inputTokens: 5000, outputTokens: 0, costUsd: 0.002, createdAt: at("2026-10-02T02:00:00Z") });
    await call_("org_a", { model: "claude-x", task: "chat", inputTokens: 200, outputTokens: 20, costUsd: null, createdAt: at("2026-10-03T02:00:00Z") });
    await call_("org_a", { model: "claude-x", task: "review", inputTokens: 7777, costUsd: 7, createdAt: at("2026-09-15T00:00:00Z") });
    await call_("org_b", { model: "claude-x", task: "review", inputTokens: 8888, costUsd: 8, createdAt: at("2026-10-02T00:00:00Z") });

    const range = resolveUsageRange({ preset: "this_month" }, at("2026-10-15T12:00:00Z"));
    expect([range.start.toISOString(), range.end.toISOString()]).toEqual(["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);

    const s = await usageSummary(db, "org_a", range);
    expect(s).toMatchObject({ credits: 7, inputTokens: 6500, outputTokens: 150, activeDevelopers: 2, unpricedCalls: 1 });
    expect(s.modelCostUsd).toBeCloseTo(0.052, 6);
    expect(s.indexingCostUsd).toBeCloseTo(0.002, 6);

    const days = await usageDaily(db, "org_a", range);
    expect(days).toHaveLength(31);
    expect(days.slice(0, 3)).toEqual([
      { day: "2026-10-01", reviews: 1, credits: 2, costUsd: 0.04 },
      { day: "2026-10-02", reviews: 2, credits: 5, costUsd: 0.012 },
      { day: "2026-10-03", reviews: 0, credits: 0, costUsd: 0 },
    ]);

    const byRepo = await usageByRepo(db, "org_a", range);
    expect(byRepo.total).toBe(2);
    expect(byRepo.items.map((r) => [r.key, r.reviews, r.credits, r.inputTokens])).toEqual([
      ["acme/api", 2, 6, 4000],
      ["acme/web", 1, 1, 700],
    ]);
    const paged = await usageByRepo(db, "org_a", range, { page: 2, pageSize: 1 });
    expect(paged).toMatchObject({ total: 2, page: 2, pageCount: 2 });
    expect(paged.items.map((r) => r.key)).toEqual(["acme/web"]);

    const byAuthor = await usageByAuthor(db, "org_a", range);
    expect(byAuthor.items.map((r) => [r.key, r.credits])).toEqual([
      ["bob", 4],
      ["alice", 3],
      ["carol", 0],
    ]);
    expect(byAuthor.items.some((r) => r.key === "mallory")).toBe(false);

    const byModel = await usageByModel(db, "org_a", range);
    expect(byModel.items.map((r) => [r.key, r.calls, r.inputTokens])).toEqual([
      ["anthropic/claude-x", 2, 1200],
      ["anthropic/claude-y", 1, 300],
      ["openai/embed-small", 1, 5000],
    ]);
    const byTask = await usageByTask(db, "org_a", range);
    expect(byTask.items.map((r) => r.key)).toEqual(["review", "verify", "embed", "chat"]);
    const byKind = await usageByKind(db, "org_a", range);
    expect(byKind.map((r) => [r.key, r.credits])).toEqual([
      ["review", 7],
      ["chat", 0],
    ]);

    // Another org sees only its own usage.
    expect((await usageSummary(db, "org_b", range)).credits).toBe(99);
    expect((await usageByRepo(db, "org_b", range)).items.map((r) => r.key)).toEqual(["(no repository)"]);

    // The page loader reads the period from the query; the view renders every section.
    const page = await loadUsagePage(db, "org_a", { period: "custom", from: "2026-10-02", to: "2026-10-02" }, at("2026-10-15T00:00:00Z"));
    expect(page.summary.credits).toBe(5);
    const html = renderToStaticMarkup(<UsageView data={page} state={{ period: "custom", from: "2026-10-02", to: "2026-10-02" }} exportHref="/api/orgs/current/usage/export?period=custom" />);
    for (const heading of ["By repository", "By pull request author", "By model", "By task", "By kind of work", "Reviews per day", "Credits per day"]) expect(html).toContain(heading);
    expect(html).toContain('data-usage-row="usage-by-repo:acme/api"');
    expect(html).toContain('href="/api/orgs/current/usage/export?period=custom"');
    expect(html).toContain('<option value="custom" selected="">Custom range</option>');
  });

  test("R4.3 period presets and custom ranges use UTC day boundaries", () => {
    const now = at("2026-03-10T15:00:00Z");
    const iso = (r: { start: Date; end: Date }) => [r.start.toISOString().slice(0, 10), r.end.toISOString().slice(0, 10)];
    expect(iso(resolveUsageRange({ preset: "last_month" }, now))).toEqual(["2026-02-01", "2026-03-01"]);
    expect(iso(resolveUsageRange({ preset: "last_30" }, now))).toEqual(["2026-02-09", "2026-03-11"]);
    expect(iso(resolveUsageRange({ preset: "last_90" }, now))).toEqual(["2025-12-11", "2026-03-11"]);
    expect(iso(resolveUsageRange({ preset: "custom", from: at("2026-01-05T00:00:00Z"), to: at("2026-01-07T00:00:00Z") }, now))).toEqual(["2026-01-05", "2026-01-08"]);
    // Invalid or inverted custom ranges fall back to this month; future ends are clamped to today; long ranges to a year.
    expect(resolveUsageRange({ preset: "custom", from: at("2026-02-05T00:00:00Z"), to: at("2026-01-05T00:00:00Z") }, now).preset).toBe("this_month");
    expect(resolveUsageRange({ preset: "bogus" }, now).preset).toBe("this_month");
    expect(iso(resolveUsageRange({ preset: "custom", from: at("2026-03-01T00:00:00Z"), to: at("2027-01-01T00:00:00Z") }, now))).toEqual(["2026-03-01", "2026-03-11"]);
    const long = resolveUsageRange({ preset: "custom", from: at("2020-01-01T00:00:00Z"), to: at("2026-03-01T00:00:00Z") }, now);
    expect((long.end.getTime() - long.start.getTime()) / 86_400_000).toBe(366);
  });

  test("R4.3 exports the period's usage as CSV, tenant-scoped and formula-safe", async () => {
    const owner = await userWithOrg(db, { login: "olivia" });
    const other = await userWithOrg(db, { login: "oscar" });
    await event(owner.org.id, { author: "=HYPERLINK(\"x\")", prNumber: 4, credits: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.5, createdAt: at("2026-03-01T10:00:00Z") });
    await event(owner.org.id, { kind: "chat", author: "bea", credits: 0, createdAt: at("2026-03-01T11:00:00Z") });
    await event(owner.org.id, { author: "old", credits: 1, createdAt: at("2026-02-01T11:00:00Z") });
    await event(other.org.id, { author: "secret-person", credits: 3, createdAt: at("2026-03-01T10:00:00Z") });

    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell(-3)).toBe("-3");

    const chunks: string[] = [];
    for await (const c of usageCsv(db, owner.org.id, resolveUsageRange({ preset: "this_month" }, NOW), 1)) chunks.push(c);
    const lines = chunks.join("").trimEnd().split("\r\n");
    expect(lines[0]).toBe("created_at,kind,repository,pr_number,author,credits,input_tokens,output_tokens,cost_usd");
    expect(lines.slice(1)).toEqual(["2026-03-01T10:00:00.000Z,review,,4,\"'=HYPERLINK(\"\"x\"\")\",2,10,5,0.500000", "2026-03-01T11:00:00.000Z,chat,,,bea,0,0,0,"]);

    const handler = createUsageExportHandler(() => ({ db, clock: { now: NOW, ttlDays: testAuthConfig.sessionTtlDays } }));
    const url = `${testAuthConfig.appUrl}/api/orgs/current/usage/export?period=this_month`;
    expect((await handler(new Request(url))).status).toBe(401);
    const res = await handler(new Request(url, { headers: { cookie: owner.cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="openreview-usage-${owner.org.slug}-2026-03-01-2026-03-31.csv"`);
    const body = await res.text();
    expect(body).toContain("bea");
    expect(body).not.toContain("secret-person");
    expect(body).not.toContain("old");
  });
});

describe("usage caps (R4.3)", () => {
  const SECRET = "gh-webhook-secret";
  const repository = { id: 1, full_name: "acme/api" };

  async function capFixture() {
    const host = new FakeGitHost();
    host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/api", defaultBranch: "main", private: true }]);
    const { repos } = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
    const queue = new MemoryQueue();
    const handler = createGitHubWebhookHandler(() => ({ db, queue, host, secret: SECRET, botMention: "openreview", appSlug: "openreview-app" }));
    const deliver = (action: string, sha: string, id: string) => {
      const body = JSON.stringify({
        action,
        installation: { id: 11 },
        repository,
        pull_request: { number: 7, draft: false, head: { sha, ref: "feature" }, base: { ref: "main", sha: "base000" }, user: { login: "dana", type: "User" } },
      });
      return handler(
        new Request("http://localhost/api/webhooks/github", {
          method: "POST",
          body,
          headers: { "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": signGitHubPayload(SECRET, body) },
        }),
      );
    };
    return { host, queue, deliver, repo: repos[0]! };
  }

  test("R4.3 a reached credit cap skips webhook reviews with one PR comment and refuses manual, API, and onboarding requests", async () => {
    const fx = await capFixture();
    await saveUsageSettings(db, { orgId: "org_a", userId: null }, { monthlyCreditCap: 10, monthlyCostCapUsd: null, alertThresholds: [80, 100], alertWebhookUrl: null }, { allowPrivate: false });
    await event("org_a", { repoId: fx.repo.id, author: "dana", credits: 10, createdAt: new Date() });

    expect(await (await fx.deliver("opened", "s1", "d-1")).json()).toMatchObject({ status: "ignored", reason: expect.stringMatching(/^usage_cap: review run \d+ skipped$/) });
    expect(await (await fx.deliver("synchronize", "s2", "d-2")).json()).toMatchObject({ status: "ignored" });
    expect(fx.queue.jobs).toHaveLength(0);
    const runs = await db.select().from(reviewRuns).orderBy(reviewRuns.id);
    expect(runs.map((r) => [r.status, r.trigger])).toEqual([
      ["skipped", "opened"],
      ["skipped", "synchronize"],
    ]);
    expect(runs.every((r) => r.statusReason?.startsWith("usage_cap: This organization reached its usage cap of 10 credits"))).toBe(true);
    const comments = fx.host.issueComments.get("acme/api#7") ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("usage cap reached");
    expect(comments[0]!.body).toContain(LIMIT_NOTICE_MARKER);

    // People asking directly get a clear error and nothing is queued.
    const manual = requestReview({ db, queue: fx.queue }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" });
    await expect(manual).rejects.toBeInstanceOf(UsageLimitError);
    await expect(manual).rejects.toThrow(/usage cap of 10 credits/);
    const onboarding = await requestManualReview({ db, queue: fx.queue }, { orgId: "org_a", userId: "u1", role: "owner" }, { repoId: fx.repo.id, prNumber: 7 });
    expect(onboarding).toMatchObject({ status: "limited" });
    const { token } = await makeKey(db, "org_a", ["reviews:write"]);
    const res = await call(apiDeps(db, { queue: fx.queue }), "POST /reviews", { token, body: { repositoryId: fx.repo.id, prNumber: 7 } });
    expect(res.status).toBe(402);
    expect(await json(res)).toMatchObject({ error: { code: "usage_limit", details: { reason: "usage_cap" } } });
    expect(fx.queue.jobs).toHaveLength(0);

    // Raising the cap lets reviews through again.
    await saveUsageSettings(db, { orgId: "org_a", userId: null }, { monthlyCreditCap: 100, monthlyCostCapUsd: null, alertThresholds: [80, 100], alertWebhookUrl: null }, { allowPrivate: false });
    expect((await fx.deliver("synchronize", "s3", "d-3")).status).toBe(202);
    expect(fx.queue.jobs.map((j) => j.name)).toEqual(["review-pr"]);
    const [review] = await db.select().from(reviews).where(eq(reviews.orgId, "org_a"));
    expect(review!.status).toBe("queued");
  });

  test("R4.3 a model cost cap also pauses chat answers and knowledge refreshes", async () => {
    await seedOrg("org_a");
    await saveUsageSettings(db, { orgId: "org_a", userId: null }, { monthlyCreditCap: null, monthlyCostCapUsd: 1, alertThresholds: [], alertWebhookUrl: null }, { allowPrivate: false });
    const now = () => at("2026-10-20T00:00:00Z");
    await call_("org_a", { costUsd: 0.6, createdAt: at("2026-10-02T00:00:00Z") });
    expect((await checkUsageLimits(db, "org_a", { kind: "chat" }, { cfg: off, now })).ok).toBe(true);
    await call_("org_a", { task: "chat", costUsd: 0.4, createdAt: at("2026-10-03T00:00:00Z") });
    for (const kind of ["chat", "knowledge", "review"] as const) {
      const verdict = await checkUsageLimits(db, "org_a", { kind }, { cfg: off, now });
      expect(verdict).toMatchObject({ ok: false, code: "usage_cap" });
      if (!verdict.ok) expect(verdict.reason).toContain("model cost cap of $1.00");
    }
    // Last month's spend does not count against this month.
    expect((await checkUsageLimits(db, "org_a", { kind: "chat" }, { cfg: off, now: () => at("2026-11-01T00:00:00Z") })).ok).toBe(true);
    // Without caps (and without billing) nothing is limited.
    await saveUsageSettings(db, { orgId: "org_a", userId: null }, { monthlyCreditCap: null, monthlyCostCapUsd: null, alertThresholds: [], alertWebhookUrl: null }, { allowPrivate: false });
    expect((await checkUsageLimits(db, "org_a", { kind: "chat" }, { cfg: off, now })).ok).toBe(true);
  });

  test("R4.3 alerts fire once per threshold per period, signed with HMAC, with a dashboard banner", async () => {
    await seedOrg("org_a", "Acme");
    const resolve = async () => ["93.184.216.34"];
    const { newSecret } = await saveUsageSettings(
      db,
      { orgId: "org_a", userId: null },
      { monthlyCreditCap: 10, monthlyCostCapUsd: null, alertThresholds: [100, 50], alertWebhookUrl: "https://hooks.example.com/usage" },
      { allowPrivate: false, resolve },
    );
    expect(newSecret).toMatch(/^orwh_/);
    expect(await getAlertSecret(db, "org_a")).toBe(newSecret);
    expect((await getUsageSettings(db, "org_a")).alertThresholds).toEqual([50, 100]);

    const posts: { url: string; headers: Headers; body: string }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
      expect(init?.redirect).toBe("manual");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    let clock = at("2026-10-05T12:00:00Z");
    const deps = { cfg: off, now: () => clock, fetch, resolve };

    await event("org_a", { credits: 4, createdAt: at("2026-10-02T00:00:00Z") });
    expect(await checkUsageAlerts(db, "org_a", deps)).toEqual([]);
    expect(usageBanners(await usageStatus(db, "org_a", deps))).toEqual([]);

    await event("org_a", { credits: 2, createdAt: at("2026-10-03T00:00:00Z") });
    const first = await checkUsageAlerts(db, "org_a", deps);
    expect(first.map((a) => [a.metric, a.threshold, a.delivered])).toEqual([["credits", 50, true]]);
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.url).toBe("https://hooks.example.com/usage");
    const ts = post.headers.get("x-openreview-timestamp")!;
    const expected = `sha256=${createHmac("sha256", newSecret!).update(`${ts}.${post.body}`).digest("hex")}`;
    expect(post.headers.get("x-openreview-signature")).toBe(expected);
    expect(signAlertPayload(newSecret!, ts, post.body)).toBe(expected);
    expect(JSON.parse(post.body)).toMatchObject({ type: "usage.threshold_reached", org: { id: "org_a", name: "Acme" }, metric: "credits", threshold: 50, value: 6, limit: 10 });
    const banners = usageBanners(await usageStatus(db, "org_a", deps));
    expect(banners).toMatchObject([{ tone: "warning", metric: "credits" }]);
    expect(banners[0]!.message).toContain("6 credits of 10 credits used (60%)");

    // Checking again (the hourly sweep, the next review) sends nothing new.
    expect(await checkUsageAlerts(db, "org_a", deps)).toEqual([]);
    expect(posts).toHaveLength(1);

    await event("org_a", { credits: 5, createdAt: at("2026-10-04T00:00:00Z") });
    expect((await checkUsageAlerts(db, "org_a", deps)).map((a) => a.threshold)).toEqual([100]);
    expect(posts).toHaveLength(2);
    const reached = usageBanners(await usageStatus(db, "org_a", deps));
    expect(reached[0]).toMatchObject({ tone: "error" });
    expect(renderToStaticMarkup(<UsageBanners banners={reached} />)).toContain("Usage limit reached");

    // A new period starts over.
    clock = at("2026-11-02T00:00:00Z");
    await event("org_a", { credits: 6, createdAt: at("2026-11-01T06:00:00Z") });
    expect((await checkUsageAlerts(db, "org_a", deps)).map((a) => a.threshold)).toEqual([50]);
    expect(posts).toHaveLength(3);
    expect(await db.select().from(usageAlerts)).toHaveLength(3);
  });

  test("R4.3 alert webhook URLs must pass the SSRF guard when saved and again when delivered", async () => {
    await seedOrg("org_a");
    const save = (url: string, resolve: () => Promise<string[]> = async () => ["93.184.216.34"], allowPrivate = false) =>
      saveUsageSettings(db, { orgId: "org_a", userId: null }, { monthlyCreditCap: 1, monthlyCostCapUsd: null, alertThresholds: [100], alertWebhookUrl: url }, { allowPrivate, resolve });
    for (const bad of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://localhost/x", "https://user:pw@hooks.example.com/x", "not a url"]) {
      await expect(save(bad), bad).rejects.toBeInstanceOf(UsageSettingsError);
    }
    await expect(save("https://internal.example.com/x", async () => ["10.0.0.7"])).rejects.toThrow(/private, loopback, or link-local/);
    await expect(save("https://rebind.example.com/x", async () => ["93.184.216.34", "192.168.1.1"])).rejects.toThrow(/private/);
    await expect(assertPublicWebhookUrl("http://10.0.0.7/x", { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    expect(parseUsageSettingsForm(formOf({ alertThresholds: "50, 2000" }))).toMatchObject({ ok: false });
    expect(parseUsageSettingsForm(formOf({ monthlyCreditCap: "-1" }))).toMatchObject({ ok: false });
    expect(parseUsageSettingsForm(formOf({ monthlyCreditCap: "100", monthlyCostCapUsd: "12.345", alertThresholds: "80%, 50" }))).toEqual({
      ok: true,
      input: { monthlyCreditCap: 100, monthlyCostCapUsd: 12.35, alertThresholds: [50, 80], alertWebhookUrl: null },
    });

    // Saved while public; at delivery the host resolves to a private address: nothing is sent and the alert says why.
    await save("https://flip.example.com/hook");
    await event("org_a", { credits: 1, createdAt: at("2026-10-02T00:00:00Z") });
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const fired = await checkUsageAlerts(db, "org_a", { cfg: off, now: () => at("2026-10-05T00:00:00Z"), fetch, resolve: async () => ["127.0.0.1"] });
    expect(fired).toMatchObject([{ threshold: 100, delivered: false }]);
    expect(fetch).not.toHaveBeenCalled();
    const [row] = await db.select().from(usageAlerts);
    expect(row!.error).toMatch(/private, loopback, or link-local/);
    expect(row!.deliveredAt).toBeNull();
  });
});

function formOf(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}
