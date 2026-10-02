import { afterEach, describe, expect, test } from "vitest";
import { mentionReplies } from "@/lib/db/schema";
import { runJob } from "@/lib/jobs/handlers";
import { MemoryQueue } from "@/lib/jobs/types";
import { FakeLlm } from "@/lib/llm/fake";
import { MENTION_MARKER, answerMention, stripMention } from "@/lib/review/mention";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { tempDir } from "./helpers/fixture-repo";
import { reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const ANSWER = "Both `services/api/handlers.ts:3` and `web/cart/summary.ts:3` call `computeTotal(items)` without `region`.";

describe("@openreview mentions", () => {
  test("R1.7 answers a PR mention with codebase context and replies on the PR", async () => {
    fx = await reviewFixture();
    const llm = new FakeLlm(() => ANSWER);
    const res = await answerMention(
      { db: fx.db, host: fx.host, llm, embedder: fx.embedder, botMention: "openreview" },
      { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, commentId: 501, body: "@openreview who calls computeTotal, and will the new region param break them?", author: "dana" },
    );
    expect(res.status).toBe("answered");

    const prompt = llm.calls[0]!.req.prompt;
    expect(prompt).toContain("# Question from @dana\nwho calls computeTotal, and will the new region param break them?");
    expect(prompt).toContain("+ export function computeTotal(items: number[], region: string)");
    expect(prompt).toContain("services/api/handlers.ts:3-5 handleCheckout (caller");
    expect(prompt).toContain("web/cart/summary.ts:3-5 renderSummary (caller");
    expect(llm.calls[0]!.req.system).toMatch(/Ground every claim in the provided code/);

    const reply = fx.host.issueComments.get("acme/shop#7")!.at(-1)!;
    expect(reply.body).toBe(
      `> who calls computeTotal, and will the new region param break them?\n\n@dana ${ANSWER}\n\n${MENTION_MARKER}`,
    );
    const [row] = await fx.db.select().from(mentionReplies);
    expect(row).toMatchObject({ orgId: "org_a", prNumber: 7, sourceCommentId: 501, replyCommentId: reply.id, answer: ANSWER });
  });

  test("R1.7 pulls in code the question names even when it is outside the diff", async () => {
    fx = await reviewFixture();
    const llm = new FakeLlm(() => "It returns the row count.");
    await answerMention(
      { db: fx.db, host: fx.host, llm, embedder: fx.embedder, botMention: "openreview" },
      { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, commentId: 502, body: "What does `build_report` return? @OpenReview", author: "li" },
    );
    expect(llm.calls[0]!.req.prompt).toContain("workers/report.py:1-2 build_report (similar, named in question)\ndef build_report(rows):");
    expect(stripMention("@OpenReview hi @openreview-bot", "openreview")).toBe("hi @openreview-bot");
  });

  test("R1.7 end to end: webhook mention → queued job → single reply, idempotent on retry", async () => {
    fx = await reviewFixture();
    const queue = new MemoryQueue();
    const llm = new FakeLlm(() => "Answer.");
    const handler = createGitHubWebhookHandler(() => ({ db: fx!.db, queue, host: fx!.host, secret: "s", botMention: "openreview" }));
    const payload = JSON.stringify({
      action: "created",
      installation: { id: 11 },
      repository: { id: 1 },
      issue: { number: 7, pull_request: {} },
      comment: { id: 900, body: "@openreview is this safe?", user: { login: "sam", type: "User" } },
    });
    const res = await handler(
      new Request("http://x/api/webhooks/github", {
        method: "POST",
        body: payload,
        headers: { "x-github-event": "issue_comment", "x-github-delivery": "d1", "x-hub-signature-256": signGitHubPayload("s", payload) },
      }),
    );
    expect(res.status).toBe(202);
    const deps = { db: fx.db, host: fx.host, queue, llm, embedder: fx.embedder, cacheDir: tempDir(), botMention: "openreview" };
    const job = queue.jobs[0]!;
    expect(job.name).toBe("answer-mention");
    await runJob(deps, "answer-mention", job.data as never);
    expect(await runJob(deps, "answer-mention", job.data as never)).toEqual({ status: "duplicate" });
    expect(fx.host.issueComments.get("acme/shop#7")!.filter((c) => c.body.includes(MENTION_MARKER))).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
  });
});
