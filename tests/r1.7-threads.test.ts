import { afterEach, describe, expect, test } from "vitest";
import { mentionReplies, reviewComments, reviews } from "@/lib/db/schema";
import { runJob, type JobDeps } from "@/lib/jobs/handlers";
import { MemoryQueue, type JobPayloads } from "@/lib/jobs/types";
import { FakeLlm } from "@/lib/llm/fake";
import { MENTION_MARKER } from "@/lib/review/mention";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { tempDir } from "./helpers/fixture-repo";
import { reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const PATH = "services/billing/pricing.ts";
const base = { installation: { id: 11 }, repository: { id: 1, full_name: "acme/shop" } };

function setup(f: Fixture) {
  const queue = new MemoryQueue();
  const llm = new FakeLlm(() => "It is called from two places; both still pass one argument.");
  const handler = createGitHubWebhookHandler(() => ({ db: f.db, queue, host: f.host, secret: "s", botMention: "openreview", appSlug: "openreview-app" }));
  let n = 0;
  const send = async (event: string, payload: object) => {
    const body = JSON.stringify(payload);
    const res = await handler(
      new Request("http://x/api/webhooks/github", {
        method: "POST",
        body,
        headers: { "x-github-event": event, "x-github-delivery": `t-${++n}`, "x-hub-signature-256": signGitHubPayload("s", body) },
      }),
    );
    return res.json();
  };
  const deps: JobDeps = { db: f.db, host: f.host, queue, llm, embedder: f.embedder, cacheDir: tempDir(), botMention: "openreview" };
  return { queue, llm, send, deps };
}

const reviewComment = (comment: object) => ({ ...base, action: "created", pull_request: { number: 7 }, comment });

describe("threaded mentions", () => {
  test("R1.7 review-comment mentions route to answer-mention with thread info and are answered in the thread", async () => {
    fx = await reviewFixture();
    const { queue, llm, send, deps } = setup(fx);
    // A teammate's inline comment starts a thread; a reply in it asks OpenReview.
    fx.host.reviewComments.set("acme/shop#7", [{ id: 600, path: PATH, line: 3, body: "Is region validated?", author: "dana", inReplyTo: null }]);
    const reply = { id: 601, in_reply_to_id: 600, path: PATH, line: 3, body: "@openreview who calls computeTotal?", user: { login: "li", type: "User" } };
    expect(await send("pull_request_review_comment", reviewComment(reply))).toEqual({ status: "accepted", jobs: [`mention-${fx.repo.id}-601`] });

    const job = queue.jobs[0]!;
    expect(job).toMatchObject({ name: "answer-mention", jobId: `mention-${fx.repo.id}-601`, priority: 1 });
    expect(job.data).toEqual({
      orgId: "org_a",
      repoId: fx.repo.id,
      prNumber: 7,
      commentId: 601,
      body: "@openreview who calls computeTotal?",
      author: "li",
      kind: "review_comment",
      inReplyTo: 600,
      path: PATH,
      line: 3,
      meta: { deliveryId: "t-1" },
    });

    expect(await runJob(deps, "answer-mention", job.data as JobPayloads["answer-mention"])).toMatchObject({ status: "answered" });
    const thread = fx.host.reviewComments.get("acme/shop#7")!;
    expect(thread.at(-1)).toMatchObject({
      inReplyTo: 600,
      path: PATH,
      body: `@li It is called from two places; both still pass one argument.\n\n${MENTION_MARKER}`,
    });
    // Nothing went to the PR conversation, and the prompt knows where the thread is.
    expect(fx.host.issueComments.get("acme/shop#7") ?? []).toEqual([]);
    expect(llm.calls[0]!.req.prompt).toContain(`Asked in an inline review thread on \`${PATH}:3\`.`);
    const [row] = await fx.db.select().from(mentionReplies);
    expect(row).toMatchObject({ sourceCommentId: 601, replyCommentId: thread.at(-1)!.id });

    // A top-level inline comment that mentions the bot becomes the thread root itself.
    fx.host.reviewComments.set("acme/shop#7", [...thread, { id: 610, path: PATH, line: 4, body: "@openreview explain", author: "li", inReplyTo: null }]);
    await send("pull_request_review_comment", reviewComment({ id: 610, path: PATH, line: 4, body: "@openreview explain", user: { login: "li", type: "User" } }));
    expect(queue.jobs.at(-1)!.data).toMatchObject({ kind: "review_comment", commentId: 610, inReplyTo: 610, line: 4 });
    await runJob(deps, "answer-mention", queue.jobs.at(-1)!.data as JobPayloads["answer-mention"]);
    expect(fx.host.reviewComments.get("acme/shop#7")!.at(-1)).toMatchObject({ inReplyTo: 610 });
  });

  test("R1.7 a reply to an OpenReview comment that mentions the bot records feedback and is answered", async () => {
    fx = await reviewFixture();
    const { queue, send } = setup(fx);
    const [review] = await fx.db.insert(reviews).values({ orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head }).returning();
    await fx.db.insert(reviewComments).values({
      orgId: "org_a",
      reviewId: review!.id,
      path: PATH,
      line: 3,
      category: "logic",
      severity: "medium",
      title: "Callers ignore region",
      body: "...",
      fingerprint: "fp",
      externalId: 700,
      headSha: fx.head,
    });
    const res = await send(
      "pull_request_review_comment",
      reviewComment({ id: 701, in_reply_to_id: 700, path: PATH, line: 3, body: "@openreview are you sure?", user: { login: "li", type: "User" } }),
    );
    expect(res).toEqual({ status: "accepted", jobs: [`feedback-${fx.repo.id}-7-701`, `mention-${fx.repo.id}-701`] });
    expect(queue.jobs.find((j) => j.name === "answer-mention")?.data).toMatchObject({ inReplyTo: 700, kind: "review_comment" });
    // Our own replies in the thread are ignored.
    expect(
      await send("pull_request_review_comment", reviewComment({ id: 702, in_reply_to_id: 700, body: "@openreview noted", user: { login: "openreview-app[bot]" } })),
    ).toEqual({ status: "ignored", reason: "comment by a bot" });
  });

  test("R1.7 review-body mentions route to answer-mention and are answered on the PR", async () => {
    fx = await reviewFixture();
    const { queue, send, deps } = setup(fx);
    const submitted = (id: number, body: string | null, user = { login: "dana", type: "User" }) => ({
      ...base,
      action: "submitted",
      pull_request: { number: 7 },
      review: { id, body, state: "commented", user },
    });
    expect(await send("pull_request_review", submitted(800, "Looks fine. @openreview does this change the tax rounding?"))).toEqual({
      status: "accepted",
      jobs: [`mention-${fx.repo.id}-review-800`],
    });
    expect(await send("pull_request_review", submitted(801, "LGTM"))).toEqual({ status: "ignored", reason: "no mention" });
    expect(await send("pull_request_review", submitted(802, null))).toEqual({ status: "ignored", reason: "no mention" });
    expect(await send("pull_request_review", submitted(803, "@openreview hi", { login: "ci", type: "Bot" }))).toEqual({
      status: "ignored",
      reason: "review by a bot",
    });
    expect(await send("pull_request_review", { ...submitted(804, "@openreview hi"), action: "dismissed" })).toEqual({
      status: "ignored",
      reason: "pull_request_review.dismissed",
    });

    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0]!;
    expect(job.data).toMatchObject({ kind: "review", commentId: 800, author: "dana", prNumber: 7 });
    await runJob(deps, "answer-mention", job.data as JobPayloads["answer-mention"]);
    const posted = fx.host.issueComments.get("acme/shop#7")!;
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe(
      `> Looks fine. does this change the tax rounding?\n\n@dana It is called from two places; both still pass one argument.\n\n${MENTION_MARKER}`,
    );
  });
});
