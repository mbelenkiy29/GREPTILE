import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { count, eq } from "drizzle-orm";
import { decryptSecret, hashToken } from "@/lib/crypto";
import { installations, mentionReplies, repos, reviews, scmCredentials, scmWebhooks, webhookDeliveries } from "@/lib/db/schema";
import { SUMMARY_MARKER } from "@/lib/engine";
import { runJob, type JobDeps } from "@/lib/jobs/handlers";
import { MemoryQueue, type JobPayloads } from "@/lib/jobs/types";
import { FakeLlm } from "@/lib/llm/fake";
import { runReviewJob } from "@/lib/review/run";
import { connectGitLab, disableConnectionRepo, listConnections, ScmConnectError } from "@/lib/scm/connections";
import { createGitLabWebhookHandler } from "@/lib/webhooks/gitlab";
import { candidateAt, engineLlm, PRICING, summaryOut } from "./helpers/engine";
import { FakeGitLab } from "./helpers/fake-scm";
import { tempDir } from "./helpers/fixture-repo";
import { HEAD_PRICING } from "./helpers/review-fixture";
import { APP_URL, PROJECT_ID, scmDeps, scmFixture } from "./helpers/scm-fixture";
import { createTestDb } from "./helpers/db";

beforeAll(() => {
  vi.stubEnv("APP_SECRET", "gitlab-test-secret-0123456789");
});

type Fx = Awaited<ReturnType<typeof scmFixture>>;
let current: Fx | undefined;
afterEach(() => current?.fx.fixture.cleanup());

const regionFinding = candidateAt(HEAD_PRICING, 3, {
  title: "New required `region` parameter breaks existing callers",
  description: "`handleCheckout` still calls `computeTotal(items)`.",
  severity: "high",
  confidence: 0.9,
  suggestion: 'export function computeTotal(items: number[], region = "default") {',
});

const reviewLlm = () =>
  engineLlm({
    review: (agent) => ({ findings: agent === "correctness" ? [regionFinding] : [] }),
    summary: () => summaryOut({ whatChanged: ["computeTotal now adds tax"], riskLevel: "high", riskRationale: "Breaks callers.", confidence: 2 }),
  });

function receiver(fx: Fx, queue = new MemoryQueue()) {
  const handler = createGitLabWebhookHandler(() => ({ db: fx.fx.db, queue, host: fx.host, botMention: "openreview" }));
  const token = fx.gitlab.hooks[0]!.token;
  let n = 0;
  const send = (payload: object, opts: { token?: string; uuid?: string; event?: string } = {}) =>
    handler(
      new Request(`${APP_URL}/api/webhooks/gitlab`, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {
          "x-gitlab-token": opts.token ?? token,
          "x-gitlab-event": opts.event ?? "Merge Request Hook",
          "x-gitlab-event-uuid": opts.uuid ?? `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
        },
      }),
    );
  return { queue, send, handler };
}

const mrEvent = (action: string, extra: Record<string, unknown> = {}) => ({
  object_kind: "merge_request",
  user: { id: 5, username: "dev" },
  project: { id: PROJECT_ID },
  object_attributes: { iid: 7, action, ...extra },
});

describe("GitLab connection", () => {
  test("R3.6 GitLab connect validates the token's scopes and stores it encrypted, never returning it", async () => {
    const db = await createTestDb();
    await db.insert((await import("@/lib/db/schema")).orgs).values([{ id: "org_a", name: "A" }, { id: "org_b", name: "B" }]);
    const gl = new FakeGitLab();
    const deps = scmDeps(db, { gitlab: gl });

    const created = await connectGitLab(deps, { orgId: "org_a", userId: null, baseUrl: gl.baseUrl, token: gl.token });
    const [cred] = await db.select().from(scmCredentials);
    expect(cred).toMatchObject({ orgId: "org_a", provider: "gitlab", baseUrl: gl.baseUrl, scopes: ["api", "read_repository"], missingScopes: [], accountLogin: "project_42_bot" });
    expect(cred!.tokenEnc).not.toContain(gl.token);
    expect(decryptSecret(cred!.tokenEnc)).toBe(gl.token);
    expect(gl.requests.map((r) => new URL(r.url).pathname)).toEqual(expect.arrayContaining(["/api/v4/personal_access_tokens/self", "/api/v4/user"]));
    const [inst] = await db.select().from(installations).where(eq(installations.id, created.installationId));
    expect(inst).toMatchObject({ provider: "gitlab", externalId: created.credentialId, scmCredentialId: created.credentialId, webUrl: gl.baseUrl, orgId: "org_a" });

    // The listing never carries the token, and other orgs see nothing.
    const listed = await listConnections(db, "org_a");
    expect(JSON.stringify(listed)).not.toContain(gl.token);
    expect(JSON.stringify(listed)).not.toContain(cred!.tokenEnc);
    expect(listed[0]).toMatchObject({ provider: "gitlab", status: "ok", accountLogin: "project_42_bot" });
    expect(await listConnections(db, "org_b")).toEqual([]);

    // Missing scopes, a rejected token, and an internal URL are refused and nothing is stored.
    gl.scopes = ["read_api"];
    await expect(connectGitLab(deps, { orgId: "org_a", userId: null, baseUrl: gl.baseUrl, token: gl.token })).rejects.toThrow(/missing the api, read_repository scopes/);
    await expect(connectGitLab(deps, { orgId: "org_a", userId: null, baseUrl: gl.baseUrl, token: "wrong-token-123" })).rejects.toThrow(/rejected the token \(401\)/);
    await expect(
      connectGitLab({ ...deps, resolve: async () => ["10.0.0.5"] }, { orgId: "org_a", userId: null, baseUrl: "https://gitlab.internal.example", token: gl.token }),
    ).rejects.toBeInstanceOf(ScmConnectError);
    await expect(connectGitLab(deps, { orgId: "org_a", userId: null, baseUrl: "http://gitlab.other.example", token: gl.token })).rejects.toThrow(/https/);
    expect(await db.select({ n: count() }).from(scmCredentials)).toEqual([{ n: 1 }]);
  });

  test("R3.6 enabling a GitLab project creates a webhook with a per-hook secret and disabling removes it", async () => {
    current = await scmFixture("gitlab");
    const { gitlab, hook, deps, fx } = current;
    expect(gitlab.hooks).toHaveLength(1);
    const remote = gitlab.hooks[0]!;
    expect(remote).toMatchObject({ projectId: PROJECT_ID, url: `${APP_URL}/api/webhooks/gitlab` });
    expect(remote.events).toMatchObject({ merge_requests_events: true, note_events: true, push_events: true, enable_ssl_verification: true });
    expect(remote.token.length).toBeGreaterThanOrEqual(32);
    // The secret is stored hashed (lookup) and encrypted (comparison), never in plain text.
    expect(hook).toMatchObject({ provider: "gitlab", externalHookId: String(remote.id), secretHash: hashToken(remote.token) });
    expect(hook.secretEnc).not.toContain(remote.token);
    expect(decryptSecret(hook.secretEnc)).toBe(remote.token);

    expect(await disableConnectionRepo(deps, "org_a", fx.repo.id)).toBe(true);
    expect(gitlab.deletedHooks).toEqual([remote.id]);
    expect(await fx.db.select().from(scmWebhooks)).toEqual([]);
    const [repo] = await fx.db.select().from(repos).where(eq(repos.id, fx.repo.id));
    expect(repo!.enabled).toBe(false);
  });
});

describe("GitLab webhooks and reviews", () => {
  test("R3.6 GitLab webhook verifies X-Gitlab-Token against its hook, stores nothing for a bad one, and dedupes deliveries", async () => {
    current = await scmFixture("gitlab");
    const { send, queue } = receiver(current);
    expect((await send(mrEvent("open"), { token: "not-the-secret" })).status).toBe(401);
    // A valid token for this hook cannot be replayed against another project.
    expect((await send({ ...mrEvent("open"), project: { id: 99 } })).status).toBe(401);
    expect(await current.fx.db.select().from(webhookDeliveries)).toEqual([]);

    const first = await send(mrEvent("open"), { uuid: "11111111-1111-4111-8111-111111111111" });
    expect(first.status).toBe(202);
    const again = await send(mrEvent("open"), { uuid: "11111111-1111-4111-8111-111111111111" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(queue.jobs.filter((j) => j.name === "review-pr")).toHaveLength(1);
    const [delivery] = await current.fx.db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ provider: "gitlab", status: "accepted", orgId: "org_a", repoId: current.fx.repo.id, event: "merge_request_hook", action: "open" });
  });

  test("R3.6 GitLab merge request opened → review job → positioned diff discussions and a summary note updated in place", async () => {
    current = await scmFixture("gitlab");
    const { fx, gitlab, host } = current;
    const { send, queue } = receiver(current);
    expect(await (await send(mrEvent("open"))).json()).toMatchObject({ status: "accepted" });
    const job = queue.jobs.find((j) => j.name === "review-pr")!;
    expect(job.data).toMatchObject({ orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head, trigger: "opened" });

    const res = await runReviewJob({ db: fx.db, host, llm: reviewLlm(), embedder: fx.embedder }, job.data as JobPayloads["review-pr"]);
    expect(res).toMatchObject({ status: "completed", posted: 1 });

    const discussions = gitlab.requests.filter((r) => r.method === "POST" && /\/merge_requests\/7\/discussions$/.test(new URL(r.url).pathname));
    expect(discussions).toHaveLength(1);
    const body = discussions[0]!.body as { body: string; position: Record<string, unknown> };
    expect(body.position).toEqual({
      position_type: "text",
      base_sha: fx.base,
      start_sha: fx.base,
      head_sha: fx.head,
      old_path: PRICING,
      new_path: PRICING,
      new_line: 3,
    });
    expect(body.body).toContain("```suggestion:-0+0\nexport function computeTotal(items: number[], region = \"default\") {\n```");

    const summaries = gitlab.notes.filter((n) => n.body.startsWith(SUMMARY_MARKER));
    expect(summaries).toHaveLength(1);
    const [review] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(review!.summaryCommentId).toBe(summaries[0]!.id);

    // A re-review edits the same summary note instead of adding one, and does not repost the finding.
    await runReviewJob({ db: fx.db, host, llm: reviewLlm(), embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" });
    expect(gitlab.notes.filter((n) => n.body.startsWith(SUMMARY_MARKER))).toHaveLength(1);
    expect(gitlab.requests.some((r) => r.method === "PUT" && new URL(r.url).pathname.endsWith(`/notes/${summaries[0]!.id}`))).toBe(true);
    expect(gitlab.requests.filter((r) => r.method === "POST" && /\/discussions$/.test(new URL(r.url).pathname))).toHaveLength(1);
  });

  test("R3.6 GitLab positions a context line with old_line and new_line, and falls back to a plain discussion when a line left the diff", async () => {
    current = await scmFixture("gitlab");
    const { client, fx, gitlab } = current;
    // Line 6 of the new pricing.ts is the unchanged closing brace (old line 3).
    await client.createReview("acme/shop", 7, { commitId: fx.head, body: "", comments: [{ path: PRICING, line: 6, body: "context" }] });
    const ctx = gitlab.requests.filter((r) => r.method === "POST" && /\/discussions$/.test(new URL(r.url).pathname)).at(-1)!;
    expect((ctx.body as { position: Record<string, unknown> }).position).toMatchObject({ new_line: 6, old_line: 3 });

    gitlab.rejectLines.add(4);
    const res = await client.createReview("acme/shop", 7, { commitId: fx.head, body: "", comments: [{ path: PRICING, line: 4, body: "moved" }] });
    const fallback = gitlab.requests.filter((r) => r.method === "POST" && /\/discussions$/.test(new URL(r.url).pathname)).at(-1)!;
    expect(fallback.body).toEqual({ body: `**\`${PRICING}:4\`**\n\nmoved` });
    expect(res.comments).toEqual([expect.objectContaining({ path: PRICING, line: 4 })]);
  });

  test("R3.6 GitLab note mentioning the bot is answered in its discussion, and a reply to a finding syncs feedback", async () => {
    current = await scmFixture("gitlab");
    const { fx, gitlab, host } = current;
    const { send, queue } = receiver(current);
    await runReviewJob({ db: fx.db, host, llm: reviewLlm(), embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head, trigger: "opened" });
    const root = gitlab.notes.find((n) => n.type === "DiffNote")!;
    gitlab.members.set(77, 30);
    const reply = gitlab.addNote({ body: "@openreview why is this a problem?", username: "li", userId: 77, type: "DiffNote", position: root.position, discussionId: root.discussionId });

    const res = await send(
      {
        object_kind: "note",
        user: { id: 77, username: "li" },
        project: { id: PROJECT_ID },
        merge_request: { iid: 7 },
        object_attributes: { id: reply.id, note: reply.body, noteable_type: "MergeRequest", discussion_id: root.discussionId, type: "DiffNote", position: { new_path: PRICING, new_line: 3 } },
      },
      { event: "Note Hook" },
    );
    expect(await res.json()).toEqual({ status: "accepted", jobs: [`feedback-${fx.repo.id}-7-${reply.id}`, `mention-${fx.repo.id}-rc-${reply.id}`] });
    const job = queue.jobs.find((j) => j.name === "answer-mention")!;
    expect(job.data).toMatchObject({ kind: "review_comment", commentId: reply.id, inReplyTo: root.id, path: PRICING, line: 3, author: "li", authorAssociation: "MEMBER" });

    const deps: JobDeps = { db: fx.db, host, queue, llm: new FakeLlm(() => "It drops the region argument callers rely on."), embedder: fx.embedder, cacheDir: tempDir(), botMention: "openreview" };
    expect(await runJob(deps, "answer-mention", job.data as JobPayloads["answer-mention"])).toMatchObject({ status: "answered" });
    const answer = gitlab.notes.at(-1)!;
    expect(answer).toMatchObject({ discussionId: root.discussionId, author: { username: "project_42_bot" } });
    expect(answer.body).toContain("It drops the region argument callers rely on.");
    expect(gitlab.requests.at(-1)!.url).toContain(`/discussions/${root.discussionId}/notes`);
    const [row] = await fx.db.select().from(mentionReplies);
    expect(row).toMatchObject({ sourceCommentId: reply.id, replyCommentId: answer.id });

    // OpenReview's own note does not trigger anything.
    const own = await send(
      { object_kind: "note", user: { id: 900, username: "project_42_bot" }, project: { id: PROJECT_ID }, merge_request: { iid: 7 }, object_attributes: { id: answer.id, note: answer.body, noteable_type: "MergeRequest", type: "DiffNote", discussion_id: root.discussionId } },
      { event: "Note Hook" },
    );
    expect(await own.json()).toEqual({ status: "ignored", reason: "comment by OpenReview" });
  });

  test("R3.6 GitLab push to the default branch queues an index job; closing a merge request queues feedback and mining", async () => {
    current = await scmFixture("gitlab");
    const { fx } = current;
    const { send, queue } = receiver(current);
    const after = "f".repeat(40);
    const push = (ref: string) => ({ object_kind: "push", ref, after, checkout_sha: after, project: { id: PROJECT_ID, default_branch: "main" } });
    expect(await (await send(push("refs/heads/feature"), { event: "Push Hook" })).json()).toEqual({ status: "ignored", reason: "not the default branch" });
    expect(await (await send(push("refs/heads/main"), { event: "Push Hook" })).json()).toEqual({ status: "accepted", jobs: [`index-${fx.repo.id}-${after}`] });
    expect(queue.jobs.find((j) => j.name === "index-repo")!.data).toMatchObject({ orgId: "org_a", repoId: fx.repo.id, mode: "incremental", afterSha: after, trigger: "push" });

    expect(await (await send(mrEvent("merge"))).json()).toEqual({ status: "accepted", jobs: [`feedback-${fx.repo.id}-7-closed`, `mine-${fx.repo.id}-7`] });
    // A title edit (no new commits) is not reviewed again.
    expect(await (await send(mrEvent("update"))).json()).toEqual({ status: "ignored", reason: "merge_request.update without new commits" });
    expect(await (await send(mrEvent("update", { oldrev: "e".repeat(40) }))).json()).toMatchObject({ status: "accepted" });
  });

  test("R3.6 GitLab connections are tenant-isolated: another org cannot see, check, or disconnect them", async () => {
    current = await scmFixture("gitlab");
    const { fx, deps, created } = current;
    await fx.db.insert((await import("@/lib/db/schema")).orgs).values({ id: "org_b", name: "B" });
    const { checkConnection, disconnectConnection, listConnectionRepos } = await import("@/lib/scm/connections");
    expect(await listConnections(fx.db, "org_b")).toEqual([]);
    expect(await checkConnection(deps, "org_b", created.credentialId)).toBeUndefined();
    expect(await listConnectionRepos(deps, "org_b", created.credentialId)).toBeUndefined();
    expect(await disconnectConnection(deps, "org_b", created.credentialId)).toBe(false);
    expect(await fx.db.select({ n: count() }).from(scmCredentials)).toEqual([{ n: 1 }]);

    // The owner disconnects: the webhook is removed on GitLab and the connection's data is gone.
    expect(await disconnectConnection(deps, "org_a", created.credentialId)).toBe(true);
    expect(current.gitlab.deletedHooks).toHaveLength(1);
    expect(await fx.db.select().from(scmCredentials)).toEqual([]);
    expect(await fx.db.select().from(repos).where(eq(repos.id, fx.repo.id))).toEqual([]);
  });
});

