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
import { FakeLlm, type FakeCall } from "@/lib/llm/fake";
import type { RawFinding } from "@/lib/review/findings";
import { runReviewJob } from "@/lib/review/run";
import { createGitHubWebhookHandler } from "@/lib/webhooks/github";
import { signGitHubPayload } from "@/lib/webhooks/signature";
import { addReviewReply } from "./helpers/fake-git";
import { addPrFromFixture } from "./helpers/pr";
import { reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const agentOf = (call: FakeCall) => /OpenReview's (\w+) reviewer/.exec(call.req.system)?.[1] ?? "summary";

const f = (path: string, line: number, title: string, severity: RawFinding["severity"] = "medium"): RawFinding => ({
  path, line, endLine: null, severity, title, body: `${title}.`, suggestion: null, confidence: 4,
});

/** Reviewer outputs keyed by agent; mutate between runs. */
function scripted(out: Record<string, RawFinding[]>) {
  return new FakeLlm((call) =>
    agentOf(call) === "summary" ? { whatChanged: ["x"], riskLevel: "low", riskRationale: "r", confidence: 4 } : { findings: out[agentOf(call)] ?? [] },
  );
}

const PRICING = "services/billing/pricing.ts";

/** First review posts a style and a logic comment; teammates then react and reply. */
async function withFeedback() {
  const f0 = await reviewFixture();
  const out = { style: [f(PRICING, 4, "Unused variable subtotal")], logic: [f(PRICING, 5, "Missing null check on items")] };
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
  return { f0, out, llm, deps, styleC: styleC!, logicC: logicC! };
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
    const { f0, out, llm, deps } = await withFeedback();
    fx = f0;
    await syncFeedback(f0, { orgId: "org_a", repoId: f0.repo.id, prNumber: 7 });
    expect((await learnedForRepo(f0.db, "org_a", f0.repo.id)).map((p) => [p.category, p.description, p.signal])).toEqual([
      ["style", "Unused variable subtotal", "suppress"],
      ["logic", "Missing null check on items", "boost"],
    ]);

    // A later PR elsewhere in the repo: the same kinds of findings come back from the model.
    const head8 = f0.fixture.commit({ "services/billing/tax.ts": "export function taxFor(amount: number, rows?: number[]) {\n  const total = amount;\n  return Math.round(total * 0.2) + rows.length;\n}\n" }, "pr8");
    addPrFromFixture(f0.host, f0.fixture, "acme/shop", { number: 8, base: f0.head, head: head8 });
    out.style = [f("services/billing/tax.ts", 2, "Unused variable total"), f("services/billing/tax.ts", 1, "Parameter naming is unclear")];
    out.logic = [f("services/billing/tax.ts", 3, "Missing null check on rows")];
    llm.calls.length = 0;
    await runReviewJob(deps, { orgId: "org_a", repoId: f0.repo.id, prNumber: 8, headSha: head8 });

    const prompt = llm.calls.find((c) => agentOf(c) === "style")!.req.prompt;
    expect(prompt).toContain("The team has rejected these kinds of comments. Do not report them:\n- (style) Unused variable subtotal");
    expect(prompt).toContain("The team values these kinds of comments. Look for them carefully:\n- (logic) Missing null check on items");
    // Equal severity and confidence: without the boost the style finding (line 1) would sort first.
    const posted = f0.host.reviews.at(-1)!.comments.map((c) => c.body.split("\n")[0]);
    expect(posted).toEqual(["**Medium · logic** — Missing null check on rows", "**Medium · style** — Parameter naming is unclear"]);
  });

  test("R2.4 new reactions are picked up before a re-review, and webhooks queue feedback collection", async () => {
    const { f0, deps, logicC } = await withFeedback();
    fx = f0;
    f0.host.reactions.set(logicC.id, [{ id: 40, content: "-1", user: "ops" }]);
    const head2 = f0.fixture.commit({ [PRICING]: "// v2\n" + f0.fixture.git("show", `${f0.head}:${PRICING}`) + "\n" }, "v2");
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
