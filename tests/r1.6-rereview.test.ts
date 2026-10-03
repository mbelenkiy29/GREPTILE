import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { findings, reviewComments, reviews } from "@/lib/db/schema";
import { creditsFor, type Candidate } from "@/lib/engine";
import { runReviewJob } from "@/lib/review/run";
import { candidateAt, engineLlm, PRICING, summaryOut } from "./helpers/engine";
import { addPrFromFixture } from "./helpers/pr";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

/** A finding on `line` of the pricing file as it reads in `content` (the PR head at review time). */
const finding = (content: string, line: number, title: string, severity: Candidate["severity"] = "high"): Candidate =>
  candidateAt(content, line, { title, description: `${title}.`, severity, confidence: 0.9 });

/** The real engine over a fake model whose correctness reviewer reports whatever `current.findings` holds at call time. */
function scriptedLlm(current: { findings: Candidate[]; whatChanged: string }) {
  return engineLlm({
    review: (agent) => ({ findings: agent === "correctness" ? current.findings : [] }),
    summary: () => summaryOut({ whatChanged: [current.whatChanged], riskLevel: "medium", riskRationale: "r", confidence: 3 }),
  });
}

async function pushCommit(f: Fixture, content: string, number = 7) {
  const head = f.fixture.commit({ [PRICING]: content }, "update");
  addPrFromFixture(f.host, f.fixture, "acme/shop", { number, base: f.base, head, title: "Add tax to totals" });
  return head;
}

/** The first two paragraphs of an inline comment: severity, category, confidence, and the title. */
const heading = (body: string) => body.split("\n\n").slice(0, 2).join(" ");

describe("re-review on new commits", () => {
  test("R1.6 updates the summary comment in place instead of posting a new one", async () => {
    fx = await reviewFixture();
    const state = { findings: [finding(HEAD_PRICING, 3, "Callers break")], whatChanged: "first pass" };
    const deps = { db: fx.db, host: fx.host, llm: scriptedLlm(state), embedder: fx.embedder };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    const firstId = fx.host.issueComments.get("acme/shop#7")![0]!.id;

    state.whatChanged = "second pass";
    const head2 = await pushCommit(fx, HEAD_PRICING + "// tweak\n");
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: head2 });

    const comments = fx.host.issueComments.get("acme/shop#7")!;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(firstId);
    expect(comments[0]!.body).toContain("- second pass");
    expect(comments[0]!.body).toContain(`reviewed ${head2.slice(0, 7)}`);
    expect(comments[0]!.body).toContain("review #2");
    // The re-detected finding kept its comment: one inline comment in total.
    expect(fx.host.reviews).toHaveLength(1);
    const [row] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(row).toMatchObject({ runs: 2, headSha: head2, creditsUsed: 2 * creditsFor("standard"), summaryCommentId: firstId });
  });

  test("R1.6 does not duplicate inline comments already posted, even when lines shift", async () => {
    fx = await reviewFixture();
    const state = { findings: [finding(HEAD_PRICING, 3, "Callers break")], whatChanged: "x" };
    const deps = { db: fx.db, host: fx.host, llm: scriptedLlm(state), embedder: fx.embedder };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });

    // A new commit inserts a line above, so the same issue is now on line 4; plus one genuinely new issue.
    const shifted = `// pricing\n${HEAD_PRICING}`;
    const head2 = await pushCommit(fx, shifted);
    state.findings = [finding(shifted, 4, "Callers break"), finding(shifted, 6, "Tax double-counted on refunds", "medium")];
    const res = await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: head2 });

    expect(res).toMatchObject({ posted: 1, skipped: 1 });
    expect(fx.host.reviews.map((r) => r.comments.map((c) => `${c.line} ${heading(c.body)}`))).toEqual([
      ["3 **High · Correctness** · high confidence (90%) **Callers break**"],
      ["6 **Medium · Correctness** · high confidence (90%) **Tax double-counted on refunds**"],
    ]);
    const [row] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(row?.commentCount).toBe(2);
    // The moved finding is the same row, now at line 4.
    const open = await fx.db.select({ title: findings.title, startLine: findings.startLine }).from(findings).where(eq(findings.visibility, "published"));
    expect(open.sort((a, b) => a.startLine - b.startLine)).toEqual([
      { title: "Callers break", startLine: 4 },
      { title: "Tax double-counted on refunds", startLine: 6 },
    ]);
  });

  test("R1.6 recognizes comments already on GitHub by fingerprint even without local records", async () => {
    fx = await reviewFixture();
    const state = { findings: [finding(HEAD_PRICING, 3, "Callers break")], whatChanged: "x" };
    const deps = { db: fx.db, host: fx.host, llm: scriptedLlm(state), embedder: fx.embedder };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    const posted = fx.host.reviewComments.get("acme/shop#7")![0]!;
    // Every local record of the publish is lost: only the comment's fingerprint marker on GitHub remains.
    await fx.db.delete(reviewComments);
    await fx.db.delete(findings);
    await fx.db.update(reviews).set({ summaryCommentId: null });

    const head2 = await pushCommit(fx, `${HEAD_PRICING}// note\n`);
    const res = await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: head2 });
    expect(res).toMatchObject({ posted: 0, skipped: 1 });
    expect(fx.host.reviews).toHaveLength(1);
    expect(fx.host.issueComments.get("acme/shop#7")).toHaveLength(1);
    // The finding is stored again and linked to the comment found by its marker.
    const [row] = await fx.db.select().from(findings).where(eq(findings.visibility, "published"));
    expect(row).toMatchObject({ title: "Callers break", externalCommentId: posted.id, status: "open" });
  });

  test("R1.6 posts a fresh summary if the previous one was deleted, and skips superseded commits", async () => {
    fx = await reviewFixture();
    const state = { findings: [] as Candidate[], whatChanged: "x" };
    const deps = { db: fx.db, host: fx.host, llm: scriptedLlm(state), embedder: fx.embedder };
    await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    fx.host.issueComments.set("acme/shop#7", []);

    const head2 = await pushCommit(fx, `${HEAD_PRICING}// v2\n`);
    expect(await runReviewJob(deps, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head })).toMatchObject({
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
