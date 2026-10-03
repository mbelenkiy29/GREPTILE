import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { completeInstallation } from "@/lib/data/installations";
import { getDelivery, listDeliveries, pruneDeliveries } from "@/lib/data/deliveries";
import type { Db } from "@/lib/db";
import { webhookDeliveries } from "@/lib/db/schema";
import { GitHubError, GitHubHost } from "@/lib/github/client";
import { runObservedJob, type JobDeps } from "@/lib/jobs/handlers";
import { MAX_RATE_LIMIT_DEFERRALS, deferIfRateLimited } from "@/lib/jobs/rate-limit";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_KEY,
  readWorkerHeartbeat,
  startHeartbeat,
  type HeartbeatStore,
} from "@/lib/jobs/heartbeat";
import { MemoryQueue, type JobName, type JobOptions, type JobPayloads, type JobQueue } from "@/lib/jobs/types";
import { FakeEmbeddings, FakeLlm } from "@/lib/llm/fake";
import { errorMessage, setLogSink } from "@/lib/log";
import { createGitHubWebhookHandler, replayDelivery, type WebhookDeps } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";
import { tempDir } from "./helpers/fixture-repo";

type Line = Record<string, unknown> & { level: string; msg: string };

/** Captures every log line (at debug level) while a test runs. */
function captureLogs() {
  const lines: Line[] = [];
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  const restore = setLogSink((line) => lines.push(JSON.parse(line) as Line));
  return {
    lines,
    stop() {
      restore();
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    },
  };
}

class FlakyQueue implements JobQueue {
  readonly inner = new MemoryQueue();
  constructor(private failures: number) {}
  async add<N extends JobName>(name: N, data: JobPayloads[N], opts: JobOptions) {
    if (this.failures-- > 0) throw new Error("queue unavailable");
    await this.inner.add(name, data, opts);
  }
}

describe("webhook delivery records", () => {
  let db: Db;
  let host: FakeGitHost;
  let deps: Omit<WebhookDeps, "queue">;
  let n = 0;

  const send = (queue: JobQueue, event: string, payload: object, id = `d-${++n}`) => {
    const body = JSON.stringify(payload);
    return createGitHubWebhookHandler(() => ({ ...deps, queue }))(
      new Request("http://x/api/webhooks/github", {
        method: "POST",
        body,
        headers: { "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": signGitHubPayload("s", body) },
      }),
    );
  };
  const pr = (installation: number, repository: number, sha: string) => ({
    action: "opened",
    installation: { id: installation },
    repository: { id: repository },
    pull_request: { number: 5, head: { sha } },
  });

  beforeEach(async () => {
    db = await createTestDb();
    host = new FakeGitHost();
    host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/api", defaultBranch: "main", private: true }]);
    host.addInstallation(22, "globex", [{ id: 3, fullName: "globex/core", defaultBranch: "main", private: true }]);
    await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
    await completeInstallation(db, host, { orgId: "org_b", orgName: "Globex", installationId: 22 });
    deps = { db, host, secret: "s", botMention: "openreview" };
  });

  test("R6.21 deliveries are persisted with their outcome and listed per org only", async () => {
    const queue = new MemoryQueue();
    await send(queue, "pull_request", pr(11, 1, "a1"), "a-accepted");
    await send(queue, "pull_request", { ...pr(11, 1, "a2"), action: "labeled" }, "a-ignored");
    await send(new FlakyQueue(1), "pull_request", pr(11, 1, "a3"), "a-failed");
    await send(queue, "pull_request", pr(22, 3, "b1"), "b-accepted");
    await send(queue, "installation", { action: "created", installation: { id: 99, account: { login: "x", type: "User" } } }, "no-org");

    const page = await listDeliveries(db, "org_a");
    expect(page.total).toBe(3);
    const byId = Object.fromEntries(page.items.map((d) => [d.deliveryId, d]));
    expect(Object.keys(byId).sort()).toEqual(["a-accepted", "a-failed", "a-ignored"]);
    expect(byId["a-accepted"]).toMatchObject({
      event: "pull_request",
      action: "opened",
      installationId: 11,
      repoFullName: "acme/api",
      status: "accepted",
      jobs: [expect.stringMatching(/^review-\d+-5-r\d+$/)],
      attempts: 1,
      replayable: false,
    });
    expect(byId["a-accepted"]!.processedAt).toBeInstanceOf(Date);
    expect(byId["a-accepted"]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(byId["a-ignored"]).toMatchObject({ status: "ignored", reason: "pull_request.labeled", jobs: [] });
    expect(byId["a-failed"]).toMatchObject({ status: "failed", error: "queue unavailable", replayable: true });
    expect(page.items[0]).not.toHaveProperty("payload");

    // Filters, pagination, and tenant scoping.
    expect((await listDeliveries(db, "org_a", { status: "failed" })).items.map((d) => d.deliveryId)).toEqual(["a-failed"]);
    const first = await listDeliveries(db, "org_a", { page: 1, pageSize: 2 });
    const second = await listDeliveries(db, "org_a", { page: 2, pageSize: 2 });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((d) => d.deliveryId)).size).toBe(3);
    expect((await listDeliveries(db, "org_b")).items.map((d) => d.deliveryId)).toEqual(["b-accepted"]);
    expect(await getDelivery(db, "org_b", "a-failed")).toBeUndefined();
    expect((await getDelivery(db, "org_a", "a-failed"))?.payload).toMatchObject({ action: "opened", pull_request: { number: 5 } });
    await expect(listDeliveries(db, "")).rejects.toThrow(/orgId/);

    // Retention removes old records across orgs.
    expect(await pruneDeliveries(db, new Date(Date.now() + 1000))).toBe(5);
    expect(await db.select().from(webhookDeliveries)).toEqual([]);
  });

  test("R6.21 a failed delivery can be replayed from its stored payload by its own org", async () => {
    await send(new FlakyQueue(1), "pull_request", pr(11, 1, "r1"), "to-replay");
    const queue = new MemoryQueue();
    expect(await replayDelivery({ ...deps, queue }, "org_b", "to-replay")).toEqual({ status: "not_found" });

    const replayed = await replayDelivery({ ...deps, queue }, "org_a", "to-replay", { requestedBy: "user_1" });
    expect(replayed).toEqual({ status: "accepted", jobs: [expect.stringMatching(/^review-\d+-5-r\d+$/)] });
    expect(queue.jobs[0]?.data).toMatchObject({ meta: { deliveryId: "to-replay", requestedBy: "user_1" } });
    expect(await getDelivery(db, "org_a", "to-replay")).toMatchObject({ status: "accepted", attempts: 2, payload: null, error: null });
    expect(await replayDelivery({ ...deps, queue }, "org_a", "to-replay")).toEqual({ status: "not_replayable", reason: "delivery is accepted" });
  });

  test("R6.21 recorded errors keep the underlying cause, redacted and within the length cap", () => {
    const wrapped = new Error(`Failed query: insert into "webhook_deliveries" ${"x".repeat(3000)}`, {
      cause: new Error("connect ECONNREFUSED 10.0.0.5:5432 https://u:sekret@db.internal"),
    });
    const msg = errorMessage(wrapped);
    expect(msg.length).toBe(2000);
    expect(msg.startsWith("Failed query: insert")).toBe(true);
    expect(msg.endsWith("(cause: connect ECONNREFUSED 10.0.0.5:5432 https://[REDACTED]@db.internal)")).toBe(true);
    expect(errorMessage(new Error("plain"))).toBe("plain");
    expect(errorMessage(new Error("fetch failed: boom", { cause: new Error("boom") }))).toBe("fetch failed: boom");
  });

  test("R6.21 webhook and job logs carry correlation ids", async () => {
    const queue = new MemoryQueue();
    const logs = captureLogs();
    try {
      await send(queue, "pull_request", pr(11, 1, "c1"), "corr-1");
      const job = queue.jobs[0]!;
      const jobDeps: JobDeps = {
        db,
        host,
        queue,
        llm: new FakeLlm(),
        embedder: new FakeEmbeddings(),
        cacheDir: tempDir(),
        botMention: "openreview",
      };
      // The repo has no PR on the fake host, so the review job fails, and that failure is logged too.
      await expect(runObservedJob(jobDeps, { name: job.name, id: job.jobId, data: job.data, attemptsMade: 0 })).rejects.toThrow();
      await runObservedJob(jobDeps, { name: "mine-rules", id: "mine-1", data: { orgId: "org_a", repoId: 1, meta: { deliveryId: "corr-2" } } });
    } finally {
      logs.stop();
    }
    const processed = logs.lines.find((l) => l.msg === "webhook processed")!;
    expect(processed).toMatchObject({
      level: "info",
      deliveryId: "corr-1",
      event: "pull_request",
      action: "opened",
      installationId: 11,
      orgId: "org_a",
      repo: "acme/api",
      prNumber: 5,
      status: "accepted",
    });
    expect(typeof processed.repoId).toBe("number");
    expect(typeof processed.durationMs).toBe("number");

    const started = logs.lines.find((l) => l.msg === "job started" && l.job === "review-pr")!;
    expect(started).toMatchObject({ jobId: queue.jobs[0]!.jobId, orgId: "org_a", prNumber: 5, deliveryId: "corr-1", attempt: 1 });
    const failed = logs.lines.find((l) => l.msg === "job failed")!;
    expect(failed).toMatchObject({ level: "error", job: "review-pr", deliveryId: "corr-1", error: expect.stringContaining("no PR") });
    expect(typeof failed.durationMs).toBe("number");
    expect(logs.lines.find((l) => l.msg === "job completed")).toMatchObject({
      job: "mine-rules",
      jobId: "mine-1",
      orgId: "org_a",
      deliveryId: "corr-2",
      outcome: "waiting",
    });
  });
});

describe("GitHub REST client", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  type Call = { method: string; url: string; auth: string | null };

  function fakeGitHub(responses: ((call: Call) => Response | undefined)[], opts: { maxWaitMs?: number } = {}) {
    const calls: Call[] = [];
    let mints = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const call = { method: init?.method ?? "GET", url: String(input), auth: new Headers(init?.headers).get("authorization") };
      calls.push(call);
      if (call.url.endsWith("/access_tokens")) {
        mints++;
        return Response.json({ token: `ghs_token${mints}_abcdefghijklmnopqrstu`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      const next = responses.shift();
      return next?.(call) ?? Response.json({});
    };
    const sleeps: number[] = [];
    const gh = new GitHubHost({ appId: "1", privateKey: pem, fetch: fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => 1_700_000_000_000, ...opts });
    return { gh, calls, sleeps, mints: () => mints };
  }

  const prJson = { number: 4, title: "t", body: null, user: { login: "dev" }, head: { sha: "h", ref: "f" }, base: { sha: "b", ref: "main" }, state: "open" };

  let logs: ReturnType<typeof captureLogs>;
  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(() => logs.stop());

  test("R6.21 the GitHub client retries secondary rate limits and server errors with backoff", async () => {
    const { gh, calls, sleeps } = fakeGitHub([
      () => new Response("You have exceeded a secondary rate limit", { status: 403, headers: { "retry-after": "3", "x-ratelimit-remaining": "4000" } }),
      () => new Response("bad gateway", { status: 502 }),
      () => Response.json(prJson, { headers: { "x-ratelimit-remaining": "3999" } }),
    ]);
    expect(await gh.client(11).getPullRequest("acme/api", 4)).toMatchObject({ number: 4, headSha: "h", author: "dev" });
    expect(sleeps).toEqual([3000, 2000]);
    expect(calls.filter((c) => c.url.includes("/pulls/4"))).toHaveLength(3);

    const retries = logs.lines.filter((l) => l.level === "warn");
    expect(retries.map((l) => [l.msg, l.status, l.waitMs])).toEqual([
      ["github rate limit hit; waiting before retry", 403, 3000],
      ["github server error; retrying", 502, 2000],
    ]);
    const ok = logs.lines.find((l) => l.msg === "github request" && l.status === 200 && String(l.path).includes("/pulls/4"))!;
    expect(ok).toMatchObject({ method: "GET", path: "/repos/acme/api/pulls/4", installationId: 11, rateLimitRemaining: 3999, attempt: 3 });
    expect(JSON.stringify(logs.lines)).not.toContain("ghs_token");
  });

  test("R6.21 the GitHub client waits for a primary rate-limit reset but fails fast beyond a minute, and never retries a failed POST", async () => {
    const resetIn = (s: number) => String(Math.floor(1_700_000_000_000 / 1000) + s);
    const limited = (s: number) => () =>
      new Response("API rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(s) } });
    const { gh, sleeps } = fakeGitHub([limited(10), () => Response.json(prJson), limited(3600)]);
    await gh.client(11).getPullRequest("acme/api", 4);
    expect(sleeps).toEqual([11_000]);
    const err = await gh.client(11).getPullRequest("acme/api", 4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ status: 403, retryAfterMs: 3_601_000 });
    expect(sleeps).toEqual([11_000]);

    const post = fakeGitHub([() => new Response("bad gateway", { status: 502 })]);
    await expect(post.gh.client(11).createIssueComment("acme/api", 4, "hi")).rejects.toMatchObject({ status: 502 });
    expect(post.calls.filter((c) => c.method === "POST" && c.url.includes("/comments"))).toHaveLength(1);

    const down = fakeGitHub([503, 503, 503, 503].map((s) => () => new Response("unavailable", { status: s })));
    await expect(down.gh.client(11).getPullRequest("acme/api", 4)).rejects.toMatchObject({ status: 503 });
    expect(down.calls.filter((c) => c.url.includes("/pulls/4"))).toHaveLength(3);
  });

  test("R6.21 on the webhook path the GitHub client fails fast on rate limits instead of outlasting the delivery timeout", async () => {
    const resetIn = (s: number) => String(Math.floor(1_700_000_000_000 / 1000) + s);
    const { gh, sleeps, calls } = fakeGitHub(
      [() => new Response("API rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(10) } })],
      { maxWaitMs: 2_000 },
    );
    await expect(gh.client(11).getPullRequest("acme/api", 4)).rejects.toMatchObject({ status: 403, retryAfterMs: 11_000 });
    expect(sleeps).toEqual([]);
    expect(calls.filter((c) => c.url.includes("/pulls/4"))).toHaveLength(1);

    // Short server-error backoffs still fit within the cap.
    const flaky = fakeGitHub([() => new Response("bad gateway", { status: 502 }), () => Response.json(prJson)], { maxWaitMs: 2_000 });
    await flaky.gh.client(11).getPullRequest("acme/api", 4);
    expect(flaky.sleeps).toEqual([1000]);
  });

  test("R6.21 a job rate-limited beyond the client's wait is delayed until the reset instead of failing", async () => {
    const moves: { at: number; token?: string }[] = [];
    const job = (attemptsStarted: number) => ({
      id: "review-1",
      name: "review-pr",
      attemptsStarted,
      moveToDelayed: async (at: number, token?: string) => void moves.push({ at, token }),
    });
    const limited = new GitHubError(403, "rate limited", 600_000);
    const now = () => 1_000_000;

    expect(await deferIfRateLimited(job(1), "tok", limited, { now })).toBe(true);
    expect(moves).toEqual([{ at: 1_000_000 + 600_000 + 1_000, token: "tok" }]);
    // Wrapped errors are recognized through their cause.
    expect(await deferIfRateLimited(job(2), "tok", new Error("review failed", { cause: limited }), { now })).toBe(true);
    // Other errors, and jobs that were already deferred too often, take the normal retry path.
    expect(await deferIfRateLimited(job(1), "tok", new GitHubError(500, "boom"), { now })).toBe(false);
    expect(await deferIfRateLimited(job(1), "tok", new Error("x"), { now })).toBe(false);
    expect(await deferIfRateLimited(job(MAX_RATE_LIMIT_DEFERRALS + 1), "tok", limited, { now })).toBe(false);
    expect(moves).toHaveLength(2);
  });

  test("R6.21 the GitHub client drops a rejected installation token and retries once with a new one", async () => {
    const { gh, calls, mints } = fakeGitHub([
      () => new Response("Bad credentials", { status: 401 }),
      () => Response.json(prJson),
      () => new Response("Bad credentials", { status: 401 }),
      () => new Response("Bad credentials", { status: 401 }),
    ]);
    await gh.client(11).getPullRequest("acme/api", 4);
    expect(mints()).toBe(2);
    const prCalls = calls.filter((c) => c.url.includes("/pulls/4"));
    expect(prCalls.map((c) => c.auth)).toEqual(["Bearer ghs_token1_abcdefghijklmnopqrstu", "Bearer ghs_token2_abcdefghijklmnopqrstu"]);
    expect(logs.lines.some((l) => l.msg === "github rejected the installation token; minting a new one" && l.installationId === 11)).toBe(true);

    // Only one refresh per request: a second 401 is an error.
    await expect(gh.client(11).getPullRequest("acme/api", 4)).rejects.toMatchObject({ status: 401 });
    expect(mints()).toBe(3);
    expect(JSON.stringify(logs.lines)).not.toContain("ghs_token");
  });
});

describe("worker heartbeat", () => {
  /** In-memory Redis subset with TTLs on a controllable clock. */
  class FakeRedis implements HeartbeatStore {
    readonly data = new Map<string, { value: string; expiresAt: number }>();
    failing = false;
    async set(key: string, value: string, _mode: "EX", seconds: number) {
      if (this.failing) throw new Error("redis down");
      this.data.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
      return "OK";
    }
    async get(key: string) {
      const e = this.data.get(key);
      return e && e.expiresAt > Date.now() ? e.value : null;
    }
    async del(key: string) {
      return this.data.delete(key) ? 1 : 0;
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  test("R6.21 the worker heartbeat is written on an interval with a TTL and read as ok, stale, or missing", async () => {
    const redis = new FakeRedis();
    let active = 2;
    expect(await readWorkerHeartbeat(redis)).toEqual({ status: "missing" });

    const hb = startHeartbeat(redis, { host: "worker-1", pid: 42, queue: "openreview", concurrency: 4, active: () => active });
    await hb.ready;
    expect(await readWorkerHeartbeat(redis)).toMatchObject({
      status: "ok",
      ageMs: 0,
      heartbeat: { host: "worker-1", pid: 42, concurrency: 4, active: 2, queue: "openreview" },
    });
    expect(await readWorkerHeartbeat(redis, { host: "worker-1" })).toMatchObject({ status: "ok" });
    expect(await readWorkerHeartbeat(redis, { host: "worker-2" })).toEqual({ status: "missing" });
    expect([...redis.data.keys()].sort()).toEqual([HEARTBEAT_KEY, `${HEARTBEAT_KEY}:worker-1`]);

    active = 3;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect((await readWorkerHeartbeat(redis))).toMatchObject({ status: "ok", heartbeat: { active: 3 } });

    // Redis writes fail: the last beat ages into stale, then expires.
    redis.failing = true;
    const logs = captureLogs();
    try {
      await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_INTERVAL_MS + 1);
    } finally {
      logs.stop();
    }
    expect(await readWorkerHeartbeat(redis)).toMatchObject({ status: "stale" });
    expect(logs.lines.filter((l) => l.msg === "worker heartbeat write failed")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await readWorkerHeartbeat(redis)).toEqual({ status: "missing" });

    redis.failing = false;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(await readWorkerHeartbeat(redis)).toMatchObject({ status: "ok" });
    await hb.stop();
    expect(await readWorkerHeartbeat(redis, { host: "worker-1" })).toEqual({ status: "missing" });
    await redis.set(HEARTBEAT_KEY, "not json", "EX", 60);
    expect(await readWorkerHeartbeat(redis)).toEqual({ status: "missing" });
  });
});
