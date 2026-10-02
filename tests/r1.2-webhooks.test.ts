import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { completeInstallation, listRepos, setRepoEnabled } from "@/lib/data/installations";
import { IN_FLIGHT_WINDOW_MS, MAX_STORED_PAYLOAD_BYTES } from "@/lib/data/deliveries";
import type { Db } from "@/lib/db";
import { webhookDeliveries } from "@/lib/db/schema";
import { JOB_PRIORITY, MemoryQueue, type JobName, type JobOptions, type JobPayloads, type JobQueue } from "@/lib/jobs/types";
import { createGitHubWebhookHandler, mentionsBot, type WebhookDeps } from "@/lib/webhooks/github";
import { signGitHubPayload, verifyGitHubSignature } from "@/lib/webhooks/signature";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";

const SECRET = "whsec_test";
let db: Db;
let queue: MemoryQueue;
let host: FakeGitHost;
let clock: Date;
let handler: (req: Request) => Promise<Response>;
let repoId: number;

const repository = { id: 1, full_name: "acme/api" };
const installation = { id: 11 };

function makeHandler(overrides: Partial<WebhookDeps> = {}) {
  return createGitHubWebhookHandler(() => ({
    db,
    queue,
    host,
    secret: SECRET,
    botMention: "openreview",
    appSlug: "openreview-app",
    now: () => clock,
    ...overrides,
  }));
}

function deliver(event: string, payload: unknown, deliveryId: string, secret = SECRET, h = handler) {
  const body = JSON.stringify(payload);
  return h(
    new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signGitHubPayload(secret, body),
      },
    }),
  );
}

function prEvent(action: string, sha = "abc123", extra: Record<string, unknown> = {}) {
  return { action, installation, repository, pull_request: { number: 7, draft: false, head: { sha }, ...extra } };
}

async function delivery(id: string) {
  const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
  return row;
}

/** A queue that throws on its first `failures` adds, like Redis being briefly unreachable. */
class FlakyQueue implements JobQueue {
  readonly inner = new MemoryQueue();
  constructor(
    private failures: number,
    private readonly message = "queue unavailable",
  ) {}
  async add<N extends JobName>(name: N, data: JobPayloads[N], opts: JobOptions) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error(this.message);
    }
    await this.inner.add(name, data, opts);
  }
}

beforeEach(async () => {
  db = await createTestDb();
  queue = new MemoryQueue();
  host = new FakeGitHost();
  clock = new Date("2026-10-01T12:00:00Z");
  host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/api", defaultBranch: "main", private: true }]);
  const { repos } = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
  repoId = repos[0]!.id;
  handler = makeHandler();
});

describe("webhook receiver", () => {
  test("R1.2 rejects requests whose signature does not verify and stores nothing", async () => {
    expect(verifyGitHubSignature(SECRET, "{}", signGitHubPayload(SECRET, "{}"))).toBe(true);
    expect(verifyGitHubSignature(SECRET, "{}", signGitHubPayload(SECRET, "{ }"))).toBe(false);
    expect(verifyGitHubSignature(SECRET, "{}", null)).toBe(false);
    const res = await deliver("pull_request", prEvent("opened"), "d-1", "wrong-secret");
    expect(res.status).toBe(401);
    expect(queue.jobs).toEqual([]);
    expect(await db.select().from(webhookDeliveries)).toEqual([]);
  });

  test("R1.2 enqueues a review for pull_request opened, synchronize, and reopened", async () => {
    expect((await deliver("pull_request", prEvent("opened", "s1"), "d-1")).status).toBe(202);
    expect((await deliver("pull_request", prEvent("synchronize", "s2"), "d-2")).status).toBe(202);
    expect((await deliver("pull_request", prEvent("reopened", "s3"), "d-3")).status).toBe(202);
    expect(queue.jobs.map((j) => [j.name, j.jobId, j.data])).toEqual(
      [
        ["s1", "opened", "d-1"],
        ["s2", "synchronize", "d-2"],
        ["s3", "reopened", "d-3"],
      ].map(([sha, trigger, deliveryId]) => [
        "review-pr",
        `review-${repoId}-7-${sha}`,
        { orgId: "org_a", repoId, prNumber: 7, headSha: sha, trigger, meta: { deliveryId } },
      ]),
    );
  });

  test("R1.2 ignores closed and draft PRs, unknown repos, and repos with reviews disabled", async () => {
    await deliver("pull_request", prEvent("closed"), "d-1");
    await deliver("pull_request", prEvent("opened", "x", { draft: true }), "d-2");
    await deliver("pull_request", { ...prEvent("opened"), repository: { id: 999 } }, "d-3");
    await setRepoEnabled(db, "org_a", repoId, false);
    const res = await deliver("pull_request", prEvent("opened"), "d-4");
    expect(await res.json()).toEqual({ status: "ignored", reason: "reviews disabled for repository" });
    // A closed PR is never reviewed (it only triggers feedback collection, see R2.4).
    expect(queue.jobs.filter((j) => j.name === "review-pr")).toEqual([]);
  });

  test("R1.2 is idempotent on redelivery of the same delivery id", async () => {
    await deliver("pull_request", prEvent("opened"), "d-1");
    const again = await deliver("pull_request", prEvent("opened"), "d-1");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    // A distinct delivery of the same PR head maps to the same job id and is deduped by the queue.
    await deliver("pull_request", prEvent("opened"), "d-2");
    expect(queue.jobs).toHaveLength(1);
    expect(await db.select().from(webhookDeliveries)).toHaveLength(2);
    expect(await delivery("d-1")).toMatchObject({ status: "accepted", attempts: 1, jobs: [`review-${repoId}-7-abc123`] });
  });

  test("R1.2 concurrent identical deliveries enqueue once and record one delivery", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => deliver("pull_request", prEvent("opened"), "d-same")));
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as { status: string }[];
    expect(bodies.filter((b) => b.status === "accepted")).toHaveLength(1);
    expect(bodies.filter((b) => b.status === "duplicate")).toHaveLength(4);
    expect(queue.jobs).toHaveLength(1);
    expect(await db.select().from(webhookDeliveries)).toHaveLength(1);
    expect(await delivery("d-same")).toMatchObject({ status: "accepted", attempts: 1 });
  });

  test("R1.2 a failed delivery is reprocessed when GitHub redelivers it", async () => {
    const flaky = new FlakyQueue(1);
    const h = makeHandler({ queue: flaky });
    const first = await deliver("pull_request", prEvent("opened", "s9"), "d-1", SECRET, h);
    expect(first.status).toBe(500);
    expect(await delivery("d-1")).toMatchObject({ status: "failed", attempts: 1, error: "queue unavailable" });

    const retried = await deliver("pull_request", prEvent("opened", "s9"), "d-1", SECRET, h);
    expect(retried.status).toBe(202);
    expect(flaky.inner.jobs.map((j) => j.jobId)).toEqual([`review-${repoId}-7-s9`]);
    expect(await delivery("d-1")).toMatchObject({ status: "accepted", attempts: 2, error: null, payload: null });
    // Once accepted, further redeliveries are duplicates.
    expect(await (await deliver("pull_request", prEvent("opened", "s9"), "d-1", SECRET, h)).json()).toEqual({ status: "duplicate" });
  });

  test("R1.2 a delivery stuck in processing is in flight for 5 minutes, then reprocessed", async () => {
    await db.insert(webhookDeliveries).values({
      deliveryId: "d-stuck",
      event: "pull_request",
      action: "opened",
      status: "processing",
      receivedAt: new Date(clock.getTime() - 60_000),
      lastAttemptAt: new Date(clock.getTime() - 60_000),
    });
    const inFlight = await deliver("pull_request", prEvent("opened"), "d-stuck");
    expect(inFlight.status).toBe(202);
    expect(await inFlight.json()).toEqual({ status: "duplicate", inFlight: true });
    expect(queue.jobs).toEqual([]);

    // The worker that claimed it died: after the in-flight window a redelivery takes over.
    clock = new Date(clock.getTime() + IN_FLIGHT_WINDOW_MS);
    const reprocessed = await deliver("pull_request", prEvent("opened"), "d-stuck");
    expect(reprocessed.status).toBe(202);
    expect(await reprocessed.json()).toEqual({ status: "accepted", jobs: [`review-${repoId}-7-abc123`] });
    expect(await delivery("d-stuck")).toMatchObject({ status: "accepted", attempts: 2, orgId: "org_a", repoId });
  });

  test("R1.2 a routing error returns 500 and persists the failure with the redacted payload", async () => {
    const h = makeHandler({ queue: new FlakyQueue(1, "connect ECONNREFUSED redis:6379") });
    const payload = prEvent("opened", "s1", { title: "Rotate key", body: "old token ghp_abcdefghijklmnopqrstuvwxyz0123" });
    const res = await deliver("pull_request", payload, "d-fail", SECRET, h);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: "failed", deliveryId: "d-fail" });

    const row = await delivery("d-fail");
    expect(row).toMatchObject({
      status: "failed",
      event: "pull_request",
      action: "opened",
      error: "connect ECONNREFUSED redis:6379",
      installationId: 11,
      orgId: "org_a",
      repoId,
      repoFullName: "acme/api",
      attempts: 1,
    });
    expect(row?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.processedAt).toEqual(clock);
    expect(row?.payload).toEqual({
      ...payload,
      pull_request: { ...payload.pull_request, body: "old token [REDACTED]" },
    });

    // Payloads too large to keep are dropped, and the record says so.
    const big = prEvent("opened", "s2", { body: "x".repeat(MAX_STORED_PAYLOAD_BYTES) });
    await deliver("pull_request", big, "d-big", SECRET, makeHandler({ queue: new FlakyQueue(1) }));
    expect(await delivery("d-big")).toMatchObject({ status: "failed", payload: null, reason: "payload too large to keep for replay" });
  });

  test("R1.2 ping is accepted; malformed payloads and bot-sent events are ignored", async () => {
    expect(await (await deliver("ping", { zen: "Keep it simple.", hook_id: 1 }, "d-ping")).json()).toEqual({ status: "accepted", jobs: [] });
    expect(await (await deliver("pull_request", { action: "opened", installation, repository }, "d-bad")).json()).toEqual({
      status: "ignored",
      reason: "malformed pull_request payload",
    });
    const fromBot = await deliver("pull_request", { ...prEvent("opened"), sender: { login: "renovate[bot]", type: "Bot" } }, "d-bot");
    expect(await fromBot.json()).toEqual({ status: "ignored", reason: "event sent by a bot" });
    const fromUs = await deliver("pull_request", { ...prEvent("synchronize"), sender: { login: "OpenReview-App[bot]" } }, "d-us");
    expect(await fromUs.json()).toEqual({ status: "ignored", reason: "event sent by a bot" });
    expect(queue.jobs).toEqual([]);
    expect(await delivery("d-bot")).toMatchObject({ status: "ignored", reason: "event sent by a bot", orgId: "org_a" });
  });

  test("R1.2 enqueues an answer for issue_comment mentions on PRs only", async () => {
    const comment = (id: number, body: string, type = "User") => ({
      action: "created",
      installation,
      repository,
      issue: { number: 7, pull_request: {} },
      comment: { id, body, user: { login: "dev", type } },
    });
    await deliver("issue_comment", comment(1, "@openreview why is this cache needed?"), "d-1");
    await deliver("issue_comment", comment(2, "no mention here"), "d-2");
    await deliver("issue_comment", comment(3, "@openreview hi", "Bot"), "d-3");
    await deliver("issue_comment", { ...comment(4, "@openreview hi"), issue: { number: 8 } }, "d-4");
    await deliver("issue_comment", { ...comment(5, "@openreview hi"), action: "edited" }, "d-5");
    expect(queue.jobs.map((j) => [j.name, j.jobId, j.data])).toEqual([
      [
        "answer-mention",
        `mention-${repoId}-1`,
        {
          orgId: "org_a",
          repoId,
          prNumber: 7,
          commentId: 1,
          body: "@openreview why is this cache needed?",
          author: "dev",
          kind: "issue_comment",
          meta: { deliveryId: "d-1" },
        },
      ],
    ]);
  });

  test("R1.2 mention detection matches the bot handle only as a whole word", () => {
    expect(mentionsBot("@openreview explain", "openreview")).toBe(true);
    expect(mentionsBot("hey @OpenReview, why?", "openreview")).toBe(true);
    expect(mentionsBot("@openreview-bot hi", "openreview")).toBe(false);
    expect(mentionsBot("email me@openreview.dev", "openreview")).toBe(false);
    expect(mentionsBot("see org/@openreview", "openreview")).toBe(false);
  });

  test("R1.2 queues re-indexing on pushes to the default branch only", async () => {
    await deliver("push", { ref: "refs/heads/feature", after: "f1", installation, repository }, "d-1");
    await deliver("push", { ref: "refs/heads/main", after: "m1", installation, repository }, "d-2");
    await deliver("push", { ref: "refs/heads/main", after: "0000000000", deleted: true, installation, repository }, "d-3");
    expect(queue.jobs.map((j) => [j.name, j.data])).toEqual([
      ["index-repo", { orgId: "org_a", repoId, mode: "full", afterSha: "m1", trigger: "push", meta: { deliveryId: "d-2" } }],
    ]);
  });

  test("R1.2 installation_repositories events resync the org's repos", async () => {
    host.addInstallation(11, "acme", [
      { id: 1, fullName: "acme/api", defaultBranch: "main", private: true },
      { id: 5, fullName: "acme/new", defaultBranch: "main", private: true },
    ]);
    const res = await deliver("installation_repositories", { action: "added", installation, repository_selection: "selected" }, "d-1");
    const repos = await listRepos(db, "org_a");
    expect(repos.map((r) => r.fullName)).toEqual(["acme/api", "acme/new"]);
    expect(queue.jobs.map((j) => j.name)).toEqual(["index-repo", "index-repo"]);
    expect(await res.json()).toEqual({ status: "accepted", jobs: repos.map((r) => `index-${r.id}-initial`) });
  });

  test("R1.2 jobs are prioritized: mentions, then reviews, then indexing", async () => {
    expect(JOB_PRIORITY["answer-mention"]).toBeLessThan(JOB_PRIORITY["review-pr"]);
    expect(JOB_PRIORITY["review-pr"]).toBeLessThan(JOB_PRIORITY["index-repo"]);
    await deliver("push", { ref: "refs/heads/main", after: "m1", installation, repository }, "d-1");
    await deliver("pull_request", prEvent("opened"), "d-2");
    await deliver(
      "issue_comment",
      { action: "created", installation, repository, issue: { number: 7, pull_request: {} }, comment: { id: 3, body: "@openreview why?", user: { login: "dev" } } },
      "d-3",
    );
    const order = [...queue.jobs].sort((a, b) => a.priority - b.priority).map((j) => j.name);
    expect(order).toEqual(["answer-mention", "review-pr", "index-repo"]);
    const q = new MemoryQueue();
    await q.add("index-repo", { orgId: "org_a", repoId, mode: "full" }, { jobId: "x", priority: 9, delay: 500 });
    expect(q.jobs[0]).toMatchObject({ priority: 9, delay: 500 });
  });
});
