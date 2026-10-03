import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { reviews } from "@/lib/db/schema";
import { creditsFor, renderFindingMarkdown, renderFlowDiagram, SUMMARY_MARKER, type Candidate } from "@/lib/engine";
import { runJob } from "@/lib/jobs/handlers";
import { MemoryQueue } from "@/lib/jobs/types";
import { runReviewJob } from "@/lib/review/run";
import { candidateAt, engineLlm, PRICING, summaryOut } from "./helpers/engine";
import { tempDir } from "./helpers/fixture-repo";
import { addPrFromFixture } from "./helpers/pr";
import { HEAD_PRICING, reviewFixture } from "./helpers/review-fixture";
import { engineFinding } from "./helpers/stub-engine";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const regionFinding = candidateAt(HEAD_PRICING, 3, {
  title: "New required `region` parameter breaks existing callers",
  description: "`handleCheckout` (services/api/handlers.ts) and `renderSummary` (web/cart/summary.ts) still call `computeTotal(items)`.",
  severity: "high",
  confidence: 0.9,
  suggestion: 'export function computeTotal(items: number[], region = "default") {',
});

const multiLine = candidateAt(HEAD_PRICING, 4, {
  endLine: 5,
  title: "Tax applied before discounts",
  description: "Apply tax to the discounted subtotal.",
  severity: "medium",
  confidence: 0.8,
  suggestion: "  const subtotal = applyDiscounts(items);\n  return subtotal + taxFor(subtotal);",
});

/** The real engine over a fake model: the correctness reviewer reports `findings`; the judge accepts them. */
function llmWith(findings: Candidate[]) {
  return engineLlm({
    review: (agent) => ({ findings: agent === "correctness" ? findings : [] }),
    summary: () => summaryOut({ whatChanged: ["computeTotal now adds tax and takes a region"], riskLevel: "high", riskRationale: "Signature change breaks two callers.", confidence: 2 }),
  });
}

describe("PR output", () => {
  test("R1.5 posts one summary comment with what changed, risk level, confidence, and a sequence diagram", async () => {
    fx = await reviewFixture();
    const res = await runReviewJob(
      { db: fx.db, host: fx.host, llm: llmWith([regionFinding]), embedder: fx.embedder },
      { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head },
    );
    expect(res).toMatchObject({ status: "completed", posted: 1 });

    const comments = fx.host.issueComments.get("acme/shop#7")!;
    expect(comments).toHaveLength(1);
    const body = comments[0]!.body;
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain("**Risk:** High · **Confidence:** 2/5");
    expect(body).toContain("- computeTotal now adds tax and takes a region");
    expect(body).toContain("| High | `services/billing/pricing.ts:3` | New required `region` parameter breaks existing callers |");
    // The change spans services/billing, services/api and web/cart, so a Mermaid sequence diagram is included.
    const mermaid = /```mermaid\n([\s\S]*?)\n```/.exec(body)?.[1];
    expect(mermaid).toBeDefined();
    expect(mermaid!.split("\n")).toEqual(
      expect.arrayContaining([
        "sequenceDiagram",
        "  participant C1 as services/api",
        "  participant C2 as services/billing",
        "  participant C3 as web/cart",
        "  PR->>C2: changes computeTotal",
        "  C1->>C2: handleCheckout → computeTotal",
        "  C3->>C2: renderSummary → computeTotal",
      ]),
    );

    const [row] = await fx.db.select().from(reviews).where(eq(reviews.repoId, fx.repo.id));
    expect(row).toMatchObject({ status: "completed", riskLevel: "high", confidence: 2, commentCount: 1, creditsUsed: creditsFor("standard"), summaryCommentId: comments[0]!.id });
  });

  test("R1.5 posts inline comments on the changed lines with GitHub suggestion blocks", async () => {
    fx = await reviewFixture();
    await runReviewJob(
      { db: fx.db, host: fx.host, llm: llmWith([regionFinding, multiLine]), embedder: fx.embedder },
      { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head },
    );
    expect(fx.host.reviews).toHaveLength(1);
    const review = fx.host.reviews[0]!;
    expect(review.commitId).toBe(fx.head);
    expect(review.comments.map((c) => [c.path, c.startLine, c.line])).toEqual([
      [PRICING, undefined, 3],
      [PRICING, 4, 5],
    ]);
    expect(review.comments[0]!.body).toContain(
      "**High · Correctness** · high confidence (90%)\n\n**New required `region` parameter breaks existing callers**\n\n`handleCheckout`",
    );
    expect(review.comments[0]!.body).toContain('```suggestion\nexport function computeTotal(items: number[], region = "default") {\n```');
    expect(review.comments[1]!.body).toContain("```suggestion\n  const subtotal = applyDiscounts(items);\n  return subtotal + taxFor(subtotal);\n```");
  });

  test("R1.5 omits the diagram when fewer than three components change and fences suggestions safely", async () => {
    fx = await reviewFixture();
    const head2 = fx.fixture.commit({ "services/billing/tax.ts": "export function taxFor(amount: number) {\n  return Math.round(amount * 0.25);\n}\n" }, "rate");
    addPrFromFixture(fx.host, fx.fixture, "acme/shop", { number: 8, base: fx.head, head: head2 });
    await runJob(
      { db: fx.db, host: fx.host, queue: new MemoryQueue(), llm: llmWith([]), embedder: fx.embedder, cacheDir: tempDir(), botMention: "openreview" },
      "review-pr",
      { orgId: "org_a", repoId: fx.repo.id, prNumber: 8, headSha: head2 },
    );
    const body = fx.host.issueComments.get("acme/shop#8")![0]!.body;
    expect(body).not.toContain("```mermaid");
    expect(body).toContain("No issues found.");
    expect(fx.host.reviews).toHaveLength(0);

    expect(renderFlowDiagram({ changed: [], components: ["a", "b"], flows: [] })).toBeNull();
    const withFence = renderFindingMarkdown(engineFinding({ fingerprint: "0123456789abcdef", suggestion: "const s = ```x```;" }));
    expect(withFence).toContain("````suggestion\nconst s = ```x```;\n````");
    expect(withFence.endsWith("<!-- openreview:fp=0123456789abcdef -->")).toBe(true);
  });
});
