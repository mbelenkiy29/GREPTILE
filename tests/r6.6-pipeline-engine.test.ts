import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { agentRuns, findings, reviewRuns, reviews } from "@/lib/db/schema";
import { MemoryQueue, type JobPayloads } from "@/lib/jobs/types";
import type { FakeCall } from "@/lib/llm/fake";
import { runReviewJob } from "@/lib/review/run";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { callerBug, engineLlm, PRICING, summaryOut } from "./helpers/engine";
import { addPrFromFixture } from "./helpers/pr";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const FIX = 'export function computeTotal(items: number[], region = "default") {';
const FIXED_PRICING = HEAD_PRICING.replace("export function computeTotal(items: number[], region: string) {", FIX);

/** Prior finding ids in a resolution prompt. */
const priorIds = (call: FakeCall) => [...call.req.prompt.matchAll(/<prior_finding nonce="[0-9a-f]+" id="(\d+)"/g)].map((m) => m[1]!);

/**
 * The real engine over a fake model. While `state.buggy`, the correctness reviewer reports the cross-file caller bug
 * (with an exact fix); afterwards it reports nothing and the resolution check says every prior finding is fixed.
 */
function scriptedLlm(state: { buggy: boolean }) {
  return engineLlm({
    review: (agent) => ({ findings: agent === "correctness" && state.buggy ? [callerBug({ suggestion: FIX })] : [] }),
    resolve: (call) => ({ results: priorIds(call).map((id) => ({ id, fixed: !state.buggy, reason: "region now has a default, so the callers work" })) }),
    summary: () => summaryOut({ riskLevel: state.buggy ? "high" : "low", confidence: state.buggy ? 2 : 5 }),
  });
}

function webhook(f: Fixture, queue: MemoryQueue) {
  const handler = createGitHubWebhookHandler(() => ({ db: f.db, queue, host: f.host, secret: "s", botMention: "openreview" }));
  return async (id: string, action: string, head: string) => {
    const body = JSON.stringify({
      action,
      installation: { id: 11 },
      repository: { id: 1 },
      pull_request: { number: 7, draft: false, head: { sha: head, ref: "feature" }, base: { ref: "main", sha: f.base } },
    });
    const res = await handler(
      new Request("http://x", { method: "POST", body, headers: { "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": signGitHubPayload("s", body) } }),
    );
    expect(await res.json()).toMatchObject({ status: "accepted" });
    const job = queue.jobs.at(-1)!;
    expect(job.name).toBe("review-pr");
    return job.data as JobPayloads["review-pr"];
  };
}

describe("pipeline with the real engine", () => {
  test("R6.6 webhook → queued run → engine stages → verified finding posted inline with a suggestion, plus the summary", async () => {
    fx = await reviewFixture();
    const queue = new MemoryQueue();
    const send = webhook(fx, queue);
    const llm = scriptedLlm({ buggy: true });
    const deps = { db: fx.db, host: fx.host, llm, embedder: fx.embedder, queue };

    const payload = await send("d-1", "opened", fx.head);
    expect(payload).toMatchObject({ orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    const res = await runReviewJob(deps, payload);
    expect(res).toMatchObject({ status: "completed", posted: 1, findings: 1 });

    // Every stage the run went through is persisted with its timing.
    const [run] = await fx.db.select().from(reviewRuns).where(eq(reviewRuns.id, res.runId));
    expect(run).toMatchObject({ status: "completed", trigger: "opened", headSha: fx.head, findingsPublished: 1, filesReviewed: 1 });
    expect(Object.keys(run!.stageTimings ?? {})).toEqual(
      expect.arrayContaining(["queued", "ingesting", "retrieving_context", "reviewing", "verifying", "summarizing", "publishing", "completed"]),
    );

    // One agent_runs row per model-backed step, attributed to the run.
    const runs = await fx.db.select().from(agentRuns).where(eq(agentRuns.reviewRunId, res.runId));
    expect(runs.map((r) => r.agent)).toEqual(expect.arrayContaining(["classifier", "correctness", "verifier", "summarizer"]));
    expect(runs.every((r) => r.orgId === "org_a" && r.status !== "error")).toBe(true);
    expect(runs.find((r) => r.agent === "correctness")).toMatchObject({ candidates: 1 });

    // The verified finding is stored, grounded in both callers, and linked to its inline comment.
    const stored = await fx.db.select().from(findings).where(eq(findings.visibility, "published"));
    expect(stored).toHaveLength(1);
    const finding = stored[0]!;
    expect(finding).toMatchObject({ status: "open", path: PRICING, startLine: 3, category: "correctness", symbol: "computeTotal", firstRunId: res.runId });
    expect(finding.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect((finding.evidence as { path: string }[]).map((e) => e.path)).toEqual(expect.arrayContaining(["services/api/handlers.ts", "web/cart/summary.ts"]));

    expect(fx.host.reviews).toHaveLength(1);
    const [comment] = fx.host.reviews[0]!.comments;
    expect(comment).toMatchObject({ path: PRICING, line: 3 });
    expect(comment!.body).toContain("**High · Correctness**");
    expect(comment!.body).toContain(`\`\`\`suggestion\n${FIX}\n\`\`\``);
    expect(comment!.body.endsWith(`<!-- openreview:fp=${finding.fingerprint} -->`)).toBe(true);
    const posted = fx.host.reviewComments.get("acme/shop#7")!;
    expect(finding.externalCommentId).toBe(posted[0]!.id);

    const summaries = fx.host.issueComments.get("acme/shop#7")!;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.body).toContain("<!-- openreview:summary -->");
    expect(summaries[0]!.body).toContain("**Risk:** High · **Confidence:** 2/5");
    expect(summaries[0]!.body).toContain("| High | `services/billing/pricing.ts:3` | Callers of computeTotal do not pass the new region argument |");
    const [review] = await fx.db.select().from(reviews);
    expect(review).toMatchObject({ status: "completed", openFindings: 1, commentCount: 1, summaryCommentId: summaries[0]!.id });
  });

  test("R6.9 a push that fixes the bug resolves the finding incrementally: its comment is edited and nothing is reposted", async () => {
    fx = await reviewFixture();
    const queue = new MemoryQueue();
    const send = webhook(fx, queue);
    const state = { buggy: true };
    const llm = scriptedLlm(state);
    const deps = { db: fx.db, host: fx.host, llm, embedder: fx.embedder, queue };
    await runReviewJob(deps, await send("d-1", "opened", fx.head));
    const [finding] = await fx.db.select().from(findings).where(eq(findings.visibility, "published"));
    const original = fx.host.reviewComments.get("acme/shop#7")![0]!.body;

    // The author gives region a default, so both callers work again.
    state.buggy = false;
    const head2 = fx.fixture.commit({ [PRICING]: FIXED_PRICING }, "default region");
    addPrFromFixture(fx.host, fx.fixture, "acme/shop", { number: 7, base: fx.base, head: head2, title: "Add tax to totals", body: "Totals now include tax." });
    llm.calls.length = 0;
    const res = await runReviewJob(deps, await send("d-2", "synchronize", head2));
    expect(res).toMatchObject({ status: "completed", posted: 0, resolved: 1, findings: 0 });

    // An incremental re-review of the new commit, which asked the resolution check about the open finding.
    const [run] = await fx.db.select().from(reviewRuns).where(eq(reviewRuns.id, res.runId));
    expect(run).toMatchObject({ sinceSha: fx.head, headSha: head2, findingsResolved: 1 });
    const resolver = llm.calls.filter((c) => c.req.meta?.agent === "resolver");
    expect(resolver).toHaveLength(1);
    expect(priorIds(resolver[0]!)).toEqual([String(finding!.id)]);

    // The finding is resolved and its original comment edited in place; no new review or summary was posted.
    const [after] = await fx.db.select().from(findings).where(eq(findings.id, finding!.id));
    expect(after).toMatchObject({ status: "resolved", resolution: "fixed", resolvedSha: head2 });
    expect(fx.host.reviews).toHaveLength(1);
    expect(fx.host.commentEdits).toEqual([{ id: finding!.externalCommentId, body: `✅ Resolved in ${head2.slice(0, 7)}\n\n${original}` }]);
    const summaries = fx.host.issueComments.get("acme/shop#7")!;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.body).toContain("No issues found.");
    expect(summaries[0]!.body).toContain("1 earlier finding resolved");
    expect(summaries[0]!.body).toContain(`reviewed ${head2.slice(0, 7)}`);
    const [review] = await fx.db.select().from(reviews);
    expect(review).toMatchObject({ runs: 2, openFindings: 0, resolvedFindings: 1, commentCount: 1 });
  });
});
