import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { count, eq } from "drizzle-orm";
import { bitbucketRepoId } from "@/lib/bitbucket/client";
import { decryptSecret } from "@/lib/crypto";
import { orgs, repos, reviews, scmCredentials, scmWebhooks, webhookDeliveries } from "@/lib/db/schema";
import { SUMMARY_MARKER } from "@/lib/engine";
import { runJob, type JobDeps } from "@/lib/jobs/handlers";
import { MemoryQueue, type JobPayloads } from "@/lib/jobs/types";
import { FakeLlm } from "@/lib/llm/fake";
import { runReviewJob } from "@/lib/review/run";
import { connectBitbucket, disableConnectionRepo, listConnections } from "@/lib/scm/connections";
import { createBitbucketWebhookHandler, signBitbucketPayload } from "@/lib/webhooks/bitbucket";
import { candidateAt, engineLlm, PRICING, summaryOut } from "./helpers/engine";
import { createTestDb } from "./helpers/db";
import { FakeBitbucket } from "./helpers/fake-scm";
import { tempDir } from "./helpers/fixture-repo";
import { HEAD_PRICING } from "./helpers/review-fixture";
import { APP_URL, BB_REPO_UUID, scmDeps, scmFixture } from "./helpers/scm-fixture";

beforeAll(() => {
  vi.stubEnv("APP_SECRET", "bitbucket-test-secret-0123456789");
});

type Fx = Awaited<ReturnType<typeof scmFixture>>;
let current: Fx | undefined;
afterEach(() => current?.fx.fixture.cleanup());

const finding = candidateAt(HEAD_PRICING, 3, {
  title: "New required `region` parameter breaks existing callers",
  description: "`handleCheckout` still calls `computeTotal(items)`.",
  severity: "high",
  confidence: 0.9,
  suggestion: 'export function computeTotal(items: number[], region = "default") {',
});

const reviewLlm = () =>
  engineLlm({
    review: (agent) => ({ findings: agent === "correctness" ? [finding] : [] }),
    summary: () => summaryOut({ whatChanged: ["computeTotal now adds tax"], riskLevel: "high", riskRationale: "Breaks callers.", confidence: 2 }),
  });

function receiver(fx: Fx, queue = new MemoryQueue()) {
  const handler = createBitbucketWebhookHandler(() => ({ db: fx.fx.db, queue, host: fx.host, botMention: "openreview" }));
  const hook = fx.bitbucket.hooks[0]!;
  let n = 0;
  const send = (event: string, payload: object, opts: { secret?: string; uuid?: string; hookUuid?: string } = {}) => {
    const body = JSON.stringify(payload);
    return handler(
      new Request(`${APP_URL}/api/webhooks/bitbucket`, {
        method: "POST",
        body,
        headers: {
          "x-event-key": event,
          "x-hook-uuid": opts.hookUuid ?? hook.uuid,
          "x-request-uuid": opts.uuid ?? `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
          "x-hub-signature": signBitbucketPayload(opts.secret ?? hook.secret, body),
        },
      }),
    );
  };
  return { queue, send };
}

const repository = { uuid: BB_REPO_UUID, full_name: "acme/shop" };
const prEvent = () => ({ actor: { uuid: "{dev}", nickname: "dev" }, repository, pullrequest: { id: 7 } });

describe("Bitbucket connection", () => {
  test("R3.6 Bitbucket connect validates the workspace credential and its scopes and stores it encrypted", async () => {
    const db = await createTestDb();
    await db.insert(orgs).values([{ id: "org_a", name: "A" }, { id: "org_b", name: "B" }]);
    const bb = new FakeBitbucket();
    const deps = scmDeps(db, { bitbucket: bb });
    await connectBitbucket(deps, { orgId: "org_a", userId: null, workspace: bb.workspace, token: bb.token });
    const [cred] = await db.select().from(scmCredentials);
    expect(cred).toMatchObject({ provider: "bitbucket", workspace: "acme", authKind: "token", scopesVerified: true, missingScopes: [], accountId: bb.me.uuid });
    expect(cred!.tokenEnc).not.toContain(bb.token);
    expect(decryptSecret(cred!.tokenEnc)).toBe(bb.token);
    expect(JSON.stringify(await listConnections(db, "org_a"))).not.toContain(bb.token);
    expect(await listConnections(db, "org_b")).toEqual([]);

    bb.scopes = ["repository", "pullrequest"];
    await expect(connectBitbucket(deps, { orgId: "org_a", userId: null, workspace: bb.workspace, token: bb.token })).rejects.toThrow(/missing the pullrequest:write, webhook scopes/);
    await expect(connectBitbucket(deps, { orgId: "org_a", userId: null, workspace: bb.workspace, token: "wrong-token-123" })).rejects.toThrow(/401/);
    await expect(connectBitbucket(deps, { orgId: "org_a", userId: null, workspace: "bad workspace!", token: bb.token })).rejects.toThrow(/workspace ID/);
    expect(await db.select({ n: count() }).from(scmCredentials)).toEqual([{ n: 1 }]);
  });

  test("R3.6 enabling a Bitbucket repository creates a signed webhook for the review events and disabling removes it", async () => {
    current = await scmFixture("bitbucket");
    const { bitbucket, hook, deps, fx } = current;
    expect(fx.repo.id).toBe(current.repo.id);
    expect(current.repo.externalId).toBe(bitbucketRepoId(BB_REPO_UUID));
    const remote = bitbucket.hooks[0]!;
    expect(remote).toMatchObject({ url: `${APP_URL}/api/webhooks/bitbucket`, fullName: "acme/shop" });
    expect(remote.events).toEqual(["pullrequest:created", "pullrequest:updated", "pullrequest:fulfilled", "pullrequest:rejected", "pullrequest:comment_created", "repo:push"]);
    expect(decryptSecret(hook.secretEnc)).toBe(remote.secret);
    expect(hook.externalHookId).toBe(remote.uuid.replace(/[{}]/g, ""));

    expect(await disableConnectionRepo(deps, "org_a", fx.repo.id)).toBe(true);
    expect(bitbucket.deletedHooks).toEqual([remote.uuid]);
    expect(await fx.db.select().from(scmWebhooks)).toEqual([]);
  });
});

describe("Bitbucket webhooks and reviews", () => {
  test("R3.6 Bitbucket webhook verifies X-Hub-Signature with its hook's secret, stores nothing for a bad one, and dedupes by X-Request-UUID", async () => {
    current = await scmFixture("bitbucket");
    const { send, queue } = receiver(current);
    expect((await send("pullrequest:created", prEvent(), { secret: "wrong-secret" })).status).toBe(401);
    expect((await send("pullrequest:created", prEvent(), { hookUuid: "{00000000-0000-4000-8000-000000000000}" })).status).toBe(401);
    expect((await send("pullrequest:created", { ...prEvent(), repository: { uuid: "{99999999-0000-4000-8000-000000000000}" } })).status).toBe(401);
    expect(await current.fx.db.select().from(webhookDeliveries)).toEqual([]);

    expect((await send("pullrequest:created", prEvent(), { uuid: "dup-1" })).status).toBe(202);
    const again = await send("pullrequest:created", prEvent(), { uuid: "dup-1" });
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(queue.jobs.filter((j) => j.name === "review-pr")).toHaveLength(1);
    const [delivery] = await current.fx.db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ provider: "bitbucket", deliveryId: "dup-1", event: "pullrequest:created", status: "accepted", orgId: "org_a" });
  });

  test("R3.6 Bitbucket pull request created → review job → inline comments with path/to and a summary comment updated in place", async () => {
    current = await scmFixture("bitbucket");
    const { fx, bitbucket, host } = current;
    const { send, queue } = receiver(current);
    await send("pullrequest:created", prEvent());
    const job = queue.jobs.find((j) => j.name === "review-pr")!;
    // The full head sha, resolved from Bitbucket's abbreviated hash.
    expect(job.data).toMatchObject({ prNumber: 7, headSha: fx.head, trigger: "opened" });
    expect(await runReviewJob({ db: fx.db, host, llm: reviewLlm(), embedder: fx.embedder }, job.data as JobPayloads["review-pr"])).toMatchObject({ status: "completed", posted: 1 });

    const posts = bitbucket.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname.endsWith("/pullrequests/7/comments"));
    const inline = posts.find((r) => (r.body as { inline?: unknown }).inline)!;
    expect((inline.body as { inline: unknown }).inline).toEqual({ path: PRICING, to: 3 });
    const raw = (inline.body as { content: { raw: string } }).content.raw;
    // No suggestion blocks or HTML on Bitbucket: the fix is a fenced diff and markers are reference definitions.
    expect(raw).not.toContain("```suggestion");
    expect(raw).toContain('```diff\n-export function computeTotal(items: number[], region: string) {\n+export function computeTotal(items: number[], region = "default") {\n```');
    expect(raw).not.toContain("<!--");
    expect(raw).not.toContain("<details>");
    expect(raw).toMatch(/\n\[\/\/\]: # \(openreview:fp=[a-f0-9]+\)$/);

    const summaries = bitbucket.comments.filter((c) => c.raw.startsWith("[//]: # (openreview:summary)"));
    expect(summaries).toHaveLength(1);
    const [review] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(review!.summaryCommentId).toBe(summaries[0]!.id);

    // A head that was already reviewed (title edit) is ignored; a manual re-review edits the summary in place.
    expect(await (await send("pullrequest:updated", prEvent())).json()).toEqual({ status: "ignored", reason: "no new commits" });
    await runReviewJob({ db: fx.db, host, llm: reviewLlm(), embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" });
    expect(bitbucket.comments.filter((c) => c.raw.startsWith("[//]: # (openreview:summary)"))).toHaveLength(1);
    expect(bitbucket.requests.some((r) => r.method === "PUT" && new URL(r.url).pathname.endsWith(`/comments/${summaries[0]!.id}`))).toBe(true);
    expect((await host.client(current.created.credentialId).listIssueComments("acme/shop", 7))[0]!.body.startsWith(SUMMARY_MARKER)).toBe(true);
  });

  test("R3.6 Bitbucket comment mentioning the bot is answered as a threaded reply under the finding", async () => {
    current = await scmFixture("bitbucket");
    const { fx, bitbucket, host } = current;
    const { send, queue } = receiver(current);
    await runReviewJob({ db: fx.db, host, llm: reviewLlm(), embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head, trigger: "opened" });
    const root = bitbucket.comments.find((c) => c.inline)!;
    bitbucket.members.add("{li}");
    const first = bitbucket.addComment({ raw: "Hmm.", nickname: "dana", uuid: "{dana}", inline: root.inline, parent: root.id });
    const question = bitbucket.addComment({ raw: "@openreview why is this a problem?", nickname: "li", uuid: "{li}", inline: root.inline, parent: first.id });

    const res = await send("pullrequest:comment_created", {
      actor: { uuid: "{li}", nickname: "li" },
      repository,
      pullrequest: { id: 7 },
      comment: { id: question.id, content: { raw: question.raw }, user: { uuid: "{li}", nickname: "li" }, inline: question.inline, parent: { id: first.id } },
    });
    expect(await res.json()).toEqual({ status: "accepted", jobs: [`feedback-${fx.repo.id}-7-${question.id}`, `mention-${fx.repo.id}-rc-${question.id}`] });
    const job = queue.jobs.find((j) => j.name === "answer-mention")!;
    // Nested replies are addressed to the thread's top-level comment (the finding).
    expect(job.data).toMatchObject({ kind: "review_comment", commentId: question.id, inReplyTo: root.id, path: PRICING, line: 3, authorAssociation: "MEMBER" });

    const deps: JobDeps = { db: fx.db, host, queue, llm: new FakeLlm(() => "Callers still pass one argument."), embedder: fx.embedder, cacheDir: tempDir(), botMention: "openreview" };
    expect(await runJob(deps, "answer-mention", job.data as JobPayloads["answer-mention"])).toMatchObject({ status: "answered" });
    const answer = bitbucket.comments.at(-1)!;
    expect(answer).toMatchObject({ parent: root.id, user: { nickname: "openreview-bot" } });
    expect(answer.raw).toContain("Callers still pass one argument.");
    expect(answer.raw).toContain("[//]: # (openreview:mention)");
  });

  test("R3.6 Bitbucket push to the default branch queues an index job; merged or declined pull requests queue feedback", async () => {
    current = await scmFixture("bitbucket");
    const { fx } = current;
    const { send } = receiver(current);
    const hash = "d".repeat(40);
    const push = (name: string) => ({ actor: { uuid: "{dev}" }, repository, push: { changes: [{ new: { type: "branch", name, target: { hash } } }] } });
    expect(await (await send("repo:push", push("feature"))).json()).toEqual({ status: "ignored", reason: "not the default branch" });
    expect(await (await send("repo:push", push("main"))).json()).toEqual({ status: "accepted", jobs: [`index-${fx.repo.id}-${hash}`] });
    expect(await (await send("pullrequest:fulfilled", prEvent())).json()).toEqual({ status: "accepted", jobs: [`feedback-${fx.repo.id}-7-closed`, `mine-${fx.repo.id}-7`] });
    const [repo] = await fx.db.select().from(repos).where(eq(repos.id, fx.repo.id));
    expect(repo!.enabled).toBe(true);
  });
});
