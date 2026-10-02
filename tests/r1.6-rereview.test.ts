import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { reviewComments, reviews } from "@/lib/db/schema";
import { FakeLlm, type FakeCall } from "@/lib/llm/fake";
import type { RawFinding } from "@/lib/review/findings";
import { runReviewJob } from "@/lib/review/run";
import { addPrFromFixture } from "./helpers/pr";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const agentOf = (call: FakeCall) => /OpenReview's (\w+) reviewer/.exec(call.req.system)?.[1] ?? "summary";
const PRICING = "services/billing/pricing.ts";

const finding = (line: number, title: string, severity: RawFinding["severity"] = "high"): RawFinding => ({
  path: PRICING,
  line,
  endLine: null,
  severity,
  title,
  body: `${title}.`,
  suggestion: null,
  confidence: 4,
});

/** LLM whose logic reviewer reports whatever `current.findings` holds at call time. */
function scriptedLlm(current: { findings: RawFinding[]; whatChanged: string }) {
  return new FakeLlm((call) =>
    agentOf(call) === "summary"
      ? { whatChanged: [current.whatChanged], riskLevel: "medium", riskRationale: "r", confidence: 3 }
      : { findings: agentOf(call) === "logic" ? current.findings : [] },
  );
}

async function pushCommit(f: Fixture, content: string, number = 7) {
  const head = f.fixture.commit({ [PRICING]: content }, "update");
  addPrFromFixture(f.host, f.fixture, "acme/shop", { number, base: f.base, head, title: "Add tax to totals" });
  return head;
}

describe("re-review on new commits", () => {
  test("R1.6 updates the summary comment in place instead of posting a new one", async () => {
    fx = await reviewFixture();
    const state = { findings: [finding(3, "Callers break")], whatChanged: "first pass" };
    const deps = { db: fx.db, host: fx.host, llm: scriptedLlm(state), embedder: fx.embedder };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    const firstId = fx.host.issueComments.get("acme/shop#7")![0]!.id;

    state.whatChanged = "second pass";
    const head2 = await pushCommit(fx, HEAD_PRICING.replace("0.2", "0.25") + "// tweak\n");
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: head2 });

    const comments = fx.host.issueComments.get("acme/shop#7")!;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(firstId);
    expect(comments[0]!.body).toContain("- second pass");
    expect(comments[0]!.body).toContain(`Reviewed ${head2.slice(0, 7)}`);
    expect(comments[0]!.body).toContain("review #2");
    const [row] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(row).toMatchObject({ runs: 2, headSha: head2, creditsUsed: 2, summaryCommentId: firstId });
  });

  test("R1.6 does not duplicate inline comments already posted, even when lines shift", async () => {
    fx = await reviewFixture();
    const state = { findings: [finding(3, "Callers break")], whatChanged: "x" };
    const deps = { db: fx.db, host: fx.host, llm: scriptedLlm(state), embedder: fx.embedder };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });

    // A new commit inserts a line above, so the same issue is now on line 4; plus one genuinely new issue.
    const head2 = await pushCommit(fx, `// pricing\n${HEAD_PRICING}`);
    state.findings = [{ ...finding(4, "Callers break") }, finding(6, "Tax double-counted on refunds", "medium")];
    const res = await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: head2 });

    expect(res).toMatchObject({ posted: 1, skipped: 1 });
    expect(fx.host.reviews.map((r) => r.comments.map((c) => `${c.line} ${c.body.split("\n")[0]}`))).toEqual([
      ["3 **High · logic** — Callers break"],
      ["6 **Medium · logic** — Tax double-counted on refunds"],
    ]);
    const [row] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(row?.commentCount).toBe(2);
  });

  test("R1.6 recognizes comments already on GitHub by fingerprint even without local records", async () => {
    fx = await reviewFixture();
    const state = { findings: [finding(3, "Callers break")], whatChanged: "x" };
    const deps = { db: fx.db, host: fx.host, llm: scriptedLlm(state), embedder: fx.embedder };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    await fx.db.delete(reviewComments);
    await fx.db.update(reviews).set({ summaryCommentId: null });

    const head2 = await pushCommit(fx, `${HEAD_PRICING}// note\n`);
    const res = await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: head2 });
    expect(res).toMatchObject({ posted: 0, skipped: 1 });
    expect(fx.host.reviews).toHaveLength(1);
    expect(fx.host.issueComments.get("acme/shop#7")).toHaveLength(1);
  });

  test("R1.6 posts a fresh summary if the previous one was deleted, and skips superseded commits", async () => {
    fx = await reviewFixture();
    const state = { findings: [], whatChanged: "x" };
    const deps = { db: fx.db, host: fx.host, llm: scriptedLlm(state), embedder: fx.embedder };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    fx.host.issueComments.set("acme/shop#7", []);

    const head2 = await pushCommit(fx, `${HEAD_PRICING}// v2\n`);
    expect(await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head })).toEqual({
      status: "superseded",
    });
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: head2 });
    const comments = fx.host.issueComments.get("acme/shop#7")!;
    expect(comments).toHaveLength(1);
    const [row] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(row?.summaryCommentId).toBe(comments[0]!.id);
    expect(row?.runs).toBe(2);
  });
});
