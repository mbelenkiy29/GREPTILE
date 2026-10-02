import { beforeEach, describe, expect, test } from "vitest";
import { completeInstallation, listRepos, setRepoEnabled } from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { webhookDeliveries } from "@/lib/db/schema";
import { MemoryQueue } from "@/lib/jobs/types";
import { createGitHubWebhookHandler, mentionsBot } from "@/lib/webhooks/github";
import { signGitHubPayload, verifyGitHubSignature } from "@/lib/webhooks/signature";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";

const SECRET = "whsec_test";
let db: Db;
let queue: MemoryQueue;
let host: FakeGitHost;
let handler: (req: Request) => Promise<Response>;
let repoId: number;

const repository = { id: 1, full_name: "acme/api" };
const installation = { id: 11 };

function deliver(event: string, payload: unknown, deliveryId: string, secret = SECRET) {
  const body = JSON.stringify(payload);
  return handler(
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

beforeEach(async () => {
  db = await createTestDb();
  queue = new MemoryQueue();
  host = new FakeGitHost();
  host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/api", defaultBranch: "main", private: true }]);
  const { repos } = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
  repoId = repos[0]!.id;
  handler = createGitHubWebhookHandler(() => ({ db, queue, host, secret: SECRET, botMention: "tracewise" }));
});

describe("webhook receiver", () => {
  test("R1.2 rejects requests whose signature does not verify", async () => {
    expect(verifyGitHubSignature(SECRET, "{}", signGitHubPayload(SECRET, "{}"))).toBe(true);
    expect(verifyGitHubSignature(SECRET, "{}", signGitHubPayload(SECRET, "{ }"))).toBe(false);
    expect(verifyGitHubSignature(SECRET, "{}", null)).toBe(false);
    const res = await deliver("pull_request", prEvent("opened"), "d-1", "wrong-secret");
    expect(res.status).toBe(401);
    expect(queue.jobs).toEqual([]);
  });

  test("R1.2 enqueues a review for pull_request opened, synchronize, and reopened", async () => {
    expect((await deliver("pull_request", prEvent("opened", "s1"), "d-1")).status).toBe(202);
    expect((await deliver("pull_request", prEvent("synchronize", "s2"), "d-2")).status).toBe(202);
    expect((await deliver("pull_request", prEvent("reopened", "s3"), "d-3")).status).toBe(202);
    expect(queue.jobs.map((j) => [j.name, j.jobId, j.data])).toEqual(
      ["s1", "s2", "s3"].map((sha) => [
        "review-pr",
        `review-${repoId}-7-${sha}`,
        { orgId: "org_a", repoId, prNumber: 7, headSha: sha },
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
    expect(queue.jobs).toEqual([]);
  });

  test("R1.2 is idempotent on redelivery of the same delivery id", async () => {
    await deliver("pull_request", prEvent("opened"), "d-1");
    const again = await deliver("pull_request", prEvent("opened"), "d-1");
    expect(await again.json()).toEqual({ status: "duplicate" });
    // A distinct delivery of the same PR head maps to the same job id and is deduped by the queue.
    await deliver("pull_request", prEvent("opened"), "d-2");
    expect(queue.jobs).toHaveLength(1);
    expect(await db.select().from(webhookDeliveries)).toHaveLength(2);
  });

  test("R1.2 enqueues an answer for issue_comment mentions on PRs only", async () => {
    const comment = (id: number, body: string, type = "User") => ({
      action: "created",
      installation,
      repository,
      issue: { number: 7, pull_request: {} },
      comment: { id, body, user: { login: "dev", type } },
    });
    await deliver("issue_comment", comment(1, "@tracewise why is this cache needed?"), "d-1");
    await deliver("issue_comment", comment(2, "no mention here"), "d-2");
    await deliver("issue_comment", comment(3, "@tracewise hi", "Bot"), "d-3");
    await deliver("issue_comment", { ...comment(4, "@tracewise hi"), issue: { number: 8 } }, "d-4");
    await deliver("issue_comment", { ...comment(5, "@tracewise hi"), action: "edited" }, "d-5");
    expect(queue.jobs.map((j) => [j.name, j.jobId, j.data])).toEqual([
      [
        "answer-mention",
        `mention-${repoId}-1`,
        { orgId: "org_a", repoId, prNumber: 7, commentId: 1, body: "@tracewise why is this cache needed?", author: "dev" },
      ],
    ]);
  });

  test("R1.2 mention detection matches the bot handle only as a whole word", () => {
    expect(mentionsBot("@tracewise explain", "tracewise")).toBe(true);
    expect(mentionsBot("hey @TraceWise, why?", "tracewise")).toBe(true);
    expect(mentionsBot("@tracewise-bot hi", "tracewise")).toBe(false);
    expect(mentionsBot("email me@tracewise.dev", "tracewise")).toBe(false);
    expect(mentionsBot("see org/@tracewise", "tracewise")).toBe(false);
  });

  test("R1.2 queues re-indexing on pushes to the default branch only", async () => {
    await deliver("push", { ref: "refs/heads/feature", after: "f1", installation, repository }, "d-1");
    await deliver("push", { ref: "refs/heads/main", after: "m1", installation, repository }, "d-2");
    expect(queue.jobs.map((j) => [j.name, j.data])).toEqual([
      ["index-repo", { orgId: "org_a", repoId, mode: "full", afterSha: "m1" }],
    ]);
  });

  test("R1.2 installation_repositories events resync the org's repos", async () => {
    host.addInstallation(11, "acme", [
      { id: 1, fullName: "acme/api", defaultBranch: "main", private: true },
      { id: 5, fullName: "acme/new", defaultBranch: "main", private: true },
    ]);
    await deliver("installation_repositories", { action: "added", installation }, "d-1");
    const repos = await listRepos(db, "org_a");
    expect(repos.map((r) => r.fullName)).toEqual(["acme/api", "acme/new"]);
    expect(queue.jobs.map((j) => j.name)).toEqual(["index-repo", "index-repo"]);
  });
});
