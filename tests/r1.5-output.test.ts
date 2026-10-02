import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { reviews } from "@/lib/db/schema";
import { runJob } from "@/lib/jobs/handlers";
import { MemoryQueue } from "@/lib/jobs/types";
import { FakeLlm, type FakeCall } from "@/lib/llm/fake";
import { SUMMARY_MARKER, renderInlineComment, renderSequenceDiagram } from "@/lib/review/format";
import type { RawFinding } from "@/lib/review/findings";
import { runReviewJob } from "@/lib/review/run";
import { tempDir } from "./helpers/fixture-repo";
import { addPrFromFixture } from "./helpers/pr";
import { reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const agentOf = (call: FakeCall) => /Tracewise's (\w+) reviewer/.exec(call.req.system)?.[1] ?? "summary";

const regionFinding: RawFinding = {
  path: "services/billing/pricing.ts",
  line: 3,
  endLine: null,
  severity: "high",
  title: "New required `region` parameter breaks existing callers",
  body: "`handleCheckout` (services/api/handlers.ts) and `renderSummary` (web/cart/summary.ts) still call `computeTotal(items)`.",
  suggestion: "export function computeTotal(items: number[], region = \"default\") {",
  confidence: 5,
};

const multiLine: RawFinding = {
  path: "services/billing/pricing.ts",
  line: 4,
  endLine: 5,
  severity: "medium",
  title: "Tax applied before discounts",
  body: "Apply tax to the discounted subtotal.",
  suggestion: "  const subtotal = applyDiscounts(items);\n  return subtotal + taxFor(subtotal);",
  confidence: 4,
};

function llmWith(findings: Record<string, RawFinding[]>) {
  return new FakeLlm((call) =>
    agentOf(call) === "summary"
      ? { whatChanged: ["computeTotal now adds tax and takes a region"], riskLevel: "high", riskRationale: "Signature change breaks two callers.", confidence: 2 }
      : { findings: findings[agentOf(call)] ?? [] },
  );
}

describe("PR output", () => {
  test("R1.5 posts one summary comment with what changed, risk level, confidence, and a sequence diagram", async () => {
    fx = await reviewFixture();
    const res = await runReviewJob(
      { db: fx.db, host: fx.host, llm: llmWith({ logic: [regionFinding] }), embedder: fx.embedder },
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
    expect(row).toMatchObject({ status: "completed", riskLevel: "high", confidence: 2, commentCount: 1, creditsUsed: 1, summaryCommentId: comments[0]!.id });
  });

  test("R1.5 posts inline comments on the changed lines with GitHub suggestion blocks", async () => {
    fx = await reviewFixture();
    await runReviewJob(
      { db: fx.db, host: fx.host, llm: llmWith({ logic: [regionFinding], style: [multiLine] }), embedder: fx.embedder },
      { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head },
    );
    expect(fx.host.reviews).toHaveLength(1);
    const review = fx.host.reviews[0]!;
    expect(review.commitId).toBe(fx.head);
    expect(review.comments.map((c) => [c.path, c.startLine, c.line])).toEqual([
      ["services/billing/pricing.ts", undefined, 3],
      ["services/billing/pricing.ts", 4, 5],
    ]);
    expect(review.comments[0]!.body).toContain(
      '**High · logic** — New required `region` parameter breaks existing callers\n\n`handleCheckout`',
    );
    expect(review.comments[0]!.body).toContain('```suggestion\nexport function computeTotal(items: number[], region = "default") {\n```');
    expect(review.comments[1]!.body).toContain("```suggestion\n  const subtotal = applyDiscounts(items);\n  return subtotal + taxFor(subtotal);\n```");
  });

  test("R1.5 omits the diagram when fewer than three components change and fences suggestions safely", async () => {
    fx = await reviewFixture();
    const head2 = fx.fixture.commit({ "services/billing/tax.ts": "export function taxFor(amount: number) {\n  return Math.round(amount * 0.25);\n}\n" }, "rate");
    addPrFromFixture(fx.host, fx.fixture, "acme/shop", { number: 8, base: fx.head, head: head2 });
    await runJob(
      { db: fx.db, host: fx.host, queue: new MemoryQueue(), llm: llmWith({}), embedder: fx.embedder, cacheDir: tempDir(), botMention: "tracewise" },
      "review-pr",
      { orgId: "org_a", repoId: fx.repo.id, prNumber: 8, headSha: head2 },
    );
    const body = fx.host.issueComments.get("acme/shop#8")![0]!.body;
    expect(body).not.toContain("```mermaid");
    expect(body).toContain("No issues found.");
    expect(fx.host.reviews).toHaveLength(0);

    expect(renderSequenceDiagram({ changed: [], impacted: [], components: ["a", "b"], flows: [] })).toBeNull();
    const withFence = renderInlineComment(
      { ...regionFinding, suggestion: "const s = ```x```;", category: "style", agents: ["style"], score: 1 },
      "0123456789abcdef",
    );
    expect(withFence).toContain("````suggestion\nconst s = ```x```;\n````");
    expect(withFence).toContain("<!-- tracewise:fp=0123456789abcdef -->");
  });
});
