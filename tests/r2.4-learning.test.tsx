import { afterEach, describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LearnedList } from "@/components/dashboard/LearnedList";
import { commentFeedback } from "@/lib/db/schema";
import { MemoryQueue } from "@/lib/jobs/types";
import {
  deleteLearnedPattern,
  learnedForRepo,
  listLearnedPatterns,
  replySentiment,
  syncFeedback,
  updateLearnedPattern,
} from "@/lib/learning";
import { createRule } from "@/lib/data/rules";
import type { Candidate } from "@/lib/engine";
import { runReviewJob } from "@/lib/review/run";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { addReviewReply } from "./helpers/fake-git";
import { candidateAt, engineLlm, reviewCalls } from "./helpers/engine";
import { addPrFromFixture } from "./helpers/pr";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

/** A medium finding on `line` of `content` (the file at the PR head). `ruleId` is set for the team-rules reviewer. */
const f = (content: string, path: string, line: number, title: string, ruleId: string | null = null): Candidate =>
  candidateAt(content, line, { path, title, description: `${title}.`, severity: "medium", confidence: 0.8, ruleId });

/** The real engine over a fake model: reviewer outputs keyed by agent; mutate between runs. */
function scripted(out: Record<string, Candidate[]>) {
  return engineLlm({ review: (agent) => ({ findings: out[agent] ?? [] }) });
}

const PRICING = "services/billing/pricing.ts";
const TAX8 = "export function taxFor(amount: number, rows?: number[]) {\n  const total = amount;\n  return Math.round(total * 0.2) + rows.length;\n}\n";

/** First review posts a team-rules and a correctness comment; teammates then react and reply. */
async function withFeedback() {
  const f0 = await reviewFixture();
  const rule = await createRule(f0.db, "org_a", { text: "Keep billing code free of dead code." });
  const ruleId = `rule:${rule.id}`;
  const out = { rules: [f(HEAD_PRICING, PRICING, 4, "Unused variable subtotal", ruleId)], correctness: [f(HEAD_PRICING, PRICING, 5, "Missing null check on items")] };
  const llm = scripted(out);
  const deps = { db: f0.db, host: f0.host, llm, embedder: f0.embedder };
  await runReviewJob(deps, { orgId: "org_a", repoId: f0.repo.id, prNumber: 7, headSha: f0.head });
  const [styleC, logicC] = f0.host.reviewComments.get("acme/shop#7")!;
  f0.host.reactions.set(styleC!.id, [
    { id: 1, content: "-1", user: "dana" },
    { id: 2, content: "+1", user: "helper[bot]" },
    { id: 3, content: "laugh", user: "eli" },
  ]);
  f0.host.reactions.set(logicC!.id, [
    { id: 4, content: "+1", user: "dana" },
    { id: 5, content: "+1", user: "eli" },
  ]);
  addReviewReply(f0.host, "acme/shop", 7, { id: 6, inReplyTo: styleC!.id, body: "False positive — this is intentional.", author: "dana" });
  addReviewReply(f0.host, "acme/shop", 7, { id: 7, inReplyTo: logicC!.id, body: "ack", author: "openreview[bot]" });
  return { f0, out, llm, deps, ruleId, styleC: styleC!, logicC: logicC! };
}

describe("learning from feedback", () => {
  test("R2.4 reply text is classified as accepting, rejecting, or neutral", () => {
    expect(replySentiment("False positive, this is intended")).toBe(-1);
    expect(replySentiment("Not an issue here, by design.")).toBe(-1);
    expect(replySentiment("Good catch, fixed in the next commit")).toBe(1);
    expect(replySentiment("Thanks!")).toBe(1);
    expect(replySentiment("Can you explain more?")).toBe(0);
  });

  test("R2.4 thumbs-up/down reactions and replies on OpenReview comments are recorded once", async () => {
    const { f0 } = await withFeedback();
    fx = f0;
    expect(await syncFeedback(f0, { orgId: "org_a", repoId: f0.repo.id, prNumber: 7 })).toEqual({ recorded: 4 });
    expect(await syncFeedback(f0, { orgId: "org_a", repoId: f0.repo.id, prNumber: 7 })).toEqual({ recorded: 0 });
    const rows = await f0.db.select().from(commentFeedback);
    expect(rows.map((r) => [r.kind, r.author, r.sentiment, r.body]).sort()).toEqual([
      ["reply", "dana", -1, "False positive — this is intentional."],
      ["thumbs_down", "dana", -1, null],
      ["thumbs_up", "dana", 1, null],
      ["thumbs_up", "eli", 1, null],
    ]);
  });

  test("R2.4 suppressed patterns stop recurring and accepted patterns are prioritized on later reviews", async () => {
    const { f0, out, llm, deps, ruleId } = await withFeedback();
    fx = f0;
    await syncFeedback(f0, { orgId: "org_a", repoId: f0.repo.id, prNumber: 7 });
    expect((await learnedForRepo(f0.db, "org_a", f0.repo.id)).map((p) => [p.category, p.description, p.signal])).toEqual([
      // Categories are the reviewer agents' (R6.14).
      ["rules", "Unused variable subtotal", "suppress"],
      ["correctness", "Missing null check on items", "boost"],
    ]);

    // A later PR elsewhere in the repo: the same kinds of findings come back from the model.
    const head8 = f0.fixture.commit({ "services/billing/tax.ts": TAX8 }, "pr8");
    addPrFromFixture(f0.host, f0.fixture, "acme/shop", { number: 8, base: f0.head, head: head8 });
    const TAX = "services/billing/tax.ts";
    out.rules = [f(TAX8, TAX, 2, "Unused variable total", ruleId), f(TAX8, TAX, 1, "Parameter naming is unclear", ruleId)];
    out.correctness = [f(TAX8, TAX, 3, "Missing null check on rows")];
    llm.calls.length = 0;
    await runReviewJob(deps, { orgId: "org_a", repoId: f0.repo.id, prNumber: 8, headSha: head8 });

    // Every reviewer is told what the team rejected and what it values.
    for (const call of reviewCalls(llm)) {
      expect(call.req.prompt).toContain("The team has rejected these kinds of comments; do not report them:\n- (rules) Unused variable subtotal");
      expect(call.req.prompt).toContain("The team values these kinds of comments; look for them carefully:\n- (correctness) Missing null check on items");
    }
    // The suppressed pattern is dropped even though the model reported it again.
    const posted = f0.host.reviews.at(-1)!.comments.map((c) => c.body.split("\n\n")[1]);
    // Equal severity and confidence: without the boost the rule-citing finding would rank first.
    expect(posted).toEqual(["**Missing null check on rows**", "**Parameter naming is unclear**"]);
  });

  test("R2.4 new reactions are picked up before a re-review, and webhooks queue feedback collection", async () => {
    const { f0, deps, logicC } = await withFeedback();
    fx = f0;
    f0.host.reactions.set(logicC.id, [{ id: 40, content: "-1", user: "ops" }]);
    const head2 = f0.fixture.commit({ [PRICING]: "// v2\n" + HEAD_PRICING }, "v2");
    addPrFromFixture(f0.host, f0.fixture, "acme/shop", { number: 7, base: f0.base, head: head2 });
    await runReviewJob(deps, { orgId: "org_a", repoId: f0.repo.id, prNumber: 7, headSha: head2 });
    expect((await f0.db.select().from(commentFeedback)).length).toBe(3);

    const queue = new MemoryQueue();
    const handler = createGitHubWebhookHandler(() => ({ db: f0.db, queue, host: f0.host, secret: "s", botMention: "openreview" }));
    const send = (event: string, payload: object, id: string) => {
      const body = JSON.stringify(payload);
      return handler(new Request("http://x", { method: "POST", body, headers: { "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": signGitHubPayload("s", body) } }));
    };
    const base = { installation: { id: 11 }, repository: { id: 1 }, pull_request: { number: 7, head: { sha: head2 } } };
    await send("pull_request_review_comment", { ...base, action: "created", comment: { id: 77, in_reply_to_id: logicC.id, body: "nope", user: { login: "ops", type: "User" } } }, "a");
    await send("pull_request_review_comment", { ...base, action: "created", comment: { id: 78, in_reply_to_id: logicC.id, body: "x", user: { login: "ci", type: "Bot" } } }, "b");
    await send("pull_request", { ...base, action: "closed" }, "c");
    expect(queue.jobs.filter((j) => j.name === "sync-feedback").map((j) => j.jobId)).toEqual([
      `feedback-${f0.repo.id}-7-77`,
      `feedback-${f0.repo.id}-7-closed`,
    ]);
  });

  test("R2.4 the Learned page shows inferred conventions, and users can edit or delete them", async () => {
    const { f0 } = await withFeedback();
    fx = f0;
    await syncFeedback(f0, { orgId: "org_a", repoId: f0.repo.id, prNumber: 7 });
    const [suppressed, boosted] = (await listLearnedPatterns(f0.db, "org_a")).map((r) => r.pattern);

    const edited = await updateLearnedPattern(f0.db, "org_a", suppressed!.id, { description: "Unused locals in billing code", signal: "neutral" });
    expect(edited).toMatchObject({ description: "Unused locals in billing code", signal: "neutral", userEdited: true });
    expect(await updateLearnedPattern(f0.db, "org_b", boosted!.id, { signal: "suppress" })).toBeUndefined();
    expect(await deleteLearnedPattern(f0.db, "org_b", boosted!.id)).toBe(false);
    expect((await learnedForRepo(f0.db, "org_a", f0.repo.id)).map((p) => p.description)).toEqual(["Missing null check on items"]);

    const items = (await listLearnedPatterns(f0.db, "org_a")).map((r) => ({ ...r.pattern, repoFullName: r.repoFullName }));
    const html = renderToStaticMarkup(<LearnedList items={items} />);
    expect(html).toContain('badge badge-ok">Prioritized</span>');
    expect(html).toContain('badge badge-muted">Observing</span>');
    expect(html).toContain("+2 / −0");
    expect(html).toContain("+0 / −2 · set by you");
    expect(html).toContain("Unused locals in billing code");
    expect(html).toContain("Missing null check on items <span class=\"mono\">(services/billing/pricing.ts)</span>");

    expect(await deleteLearnedPattern(f0.db, "org_a", boosted!.id)).toBe(true);
    expect(await learnedForRepo(f0.db, "org_a", f0.repo.id)).toEqual([]);
    expect(renderToStaticMarkup(<LearnedList items={[]} />)).toContain("Nothing learned yet");
  });
});
