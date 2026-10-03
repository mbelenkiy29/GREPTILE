import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { findings as findingsTable, pullRequests, reviews } from "@/lib/db/schema";
import { SUMMARY_MARKER } from "@/lib/review/publish";
import { pipelineFixture, PRICING } from "./helpers/pipeline";
import { engineFinding, reviewOutput, stubEngine } from "./helpers/stub-engine";
import { HEAD_PRICING } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof pipelineFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

describe("publishing and incremental re-review", () => {
  test("R1.5 posts a run's new findings as one GitHub review with suggestion blocks, plus the summary comment", async () => {
    fx = await pipelineFixture();
    const findings = [
      engineFinding(),
      engineFinding({ fingerprint: "fp-tax", title: "Tax before discounts", severity: "medium", startLine: 4, endLine: 5, suggestion: "  a();\n  b();", category: "rules" }),
      engineFinding({ fingerprint: "fp-plain", title: "No fix", startLine: 2, endLine: 2, suggestion: null, suggestedFix: "Validate the input first." }),
    ];
    const diagram = "sequenceDiagram\n  participant A as services/api\n  A->>B: computeTotal";
    await fx.review(stubEngine(() => reviewOutput({ findings, summary: { ...reviewOutput().summary, diagram } })).run);

    expect(fx.host.reviews).toHaveLength(1);
    const review = fx.host.reviews[0]!;
    expect(review.commitId).toBe(fx.head);
    expect(review.comments.map((c) => [c.path, c.startLine, c.line])).toEqual([
      [PRICING, undefined, 3],
      [PRICING, 4, 5],
      [PRICING, undefined, 2],
    ]);
    // The engine's renderer writes the comment: severity, category, confidence, title, explanation, fix, marker.
    expect(review.comments[0]!.body).toContain("**High · Correctness** · high confidence (90%)\n\n**Callers break**\n\nTwo callers still pass one argument.");
    expect(review.comments[0]!.body).toContain('```suggestion\nexport function computeTotal(items: number[], region = "default") {\n```');
    expect(review.comments[1]!.body).toContain("```suggestion\n  a();\n  b();\n```");
    expect(review.comments[2]!.body).toContain("**Suggested fix:** Validate the input first.");
    expect(review.comments[0]!.body).toContain("<!-- openreview:fp=fp-callers-break -->");

    const [summary] = fx.host.issueComments.get("acme/shop#7")!;
    expect(summary!.body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(summary!.body).toContain("**Risk:** High · **Confidence:** 2/5");
    expect(summary!.body).toContain("- computeTotal adds tax\n- computeTotal takes a region");
    expect(summary!.body).toContain("```mermaid\n" + diagram + "\n```");
    expect(summary!.body).toContain("| High | `services/billing/pricing.ts:3` | Callers break |");
  });

  test("R1.6 re-reviews only files changed since the last reviewed commit, unless a full review is asked", async () => {
    fx = await pipelineFixture();
    const engine = stubEngine(() => reviewOutput());
    await fx.review(engine.run);
    expect(engine.calls[0]!.incremental).toBeUndefined();
    const [pr] = await fx.db.select().from(pullRequests);
    expect(pr).toMatchObject({ number: 7, lastReviewedSha: fx.head, author: "dana", state: "open" });

    const head2 = fx.push({ "services/billing/tax.ts": "export function taxFor(amount: number) {\n  return 0;\n}\n" });
    await fx.review(engine.run, { trigger: "synchronize", headSha: head2 });
    expect(engine.calls[1]!.incremental).toEqual({ sinceSha: fx.head, changedPaths: ["services/billing/tax.ts"] });
    expect(engine.calls[1]!.files.map((f) => f.path).sort()).toEqual([PRICING, "services/billing/tax.ts"]);

    await fx.review(engine.run, { full: true });
    expect(engine.calls[2]!.incremental).toBeUndefined();

    // An unreachable baseline (e.g. after a force-push) falls back to a full review.
    const head3 = fx.push({ [PRICING]: `${HEAD_PRICING}// x\n` });
    fx.host.compareAt = () => {
      throw new Error("404 No common ancestor");
    };
    await fx.review(engine.run, { trigger: "synchronize", headSha: head3 });
    expect(engine.calls[3]!.incremental).toBeUndefined();
    expect(engine.calls[3]!.headSha).toBe(head3);
  });

  test("R1.6 updates the summary in place and never reposts an inline comment across runs", async () => {
    fx = await pipelineFixture();
    let out = reviewOutput({ findings: [engineFinding()] });
    const engine = stubEngine(() => out);
    await fx.review(engine.run);
    const summaryId = fx.host.issueComments.get("acme/shop#7")![0]!.id;

    const head2 = fx.push({ [PRICING]: `// moved\n${HEAD_PRICING}` });
    out = reviewOutput({
      findings: [engineFinding({ startLine: 4, endLine: 4 }), engineFinding({ fingerprint: "fp-new", title: "New issue", startLine: 6, endLine: 6 })],
      summary: { ...out.summary, whatChanged: ["second pass"] },
    });
    expect(await fx.review(engine.run, { trigger: "synchronize", headSha: head2 })).toMatchObject({ posted: 1, skipped: 1 });

    const comments = fx.host.issueComments.get("acme/shop#7")!;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(summaryId);
    expect(comments[0]!.body).toContain("- second pass");
    expect(comments[0]!.body).toContain(`reviewed ${head2.slice(0, 7)}`);
    expect(comments[0]!.body).toContain("review #2");
    expect(comments[0]!.body).toContain("### Findings (2)");
    expect(fx.host.reviews.map((r) => r.comments.map((c) => c.line))).toEqual([[3], [6]]);

    // A third run with nothing new posts no review at all.
    expect(await fx.review(engine.run, { trigger: "manual" })).toMatchObject({ posted: 0, skipped: 2 });
    expect(fx.host.reviews).toHaveLength(2);
    const [row] = await fx.db.select().from(reviews);
    expect(row).toMatchObject({ runs: 3, summaryCommentId: summaryId, commentCount: 2, openFindings: 2 });
  });

  test("R1.6 the summary keeps listing open findings in files the incremental re-review did not touch", async () => {
    fx = await pipelineFixture();
    let out = reviewOutput({ findings: [engineFinding()] });
    const engine = stubEngine(() => out);
    await fx.review(engine.run);

    // A push that touches another file: the engine re-checks only that file and neither re-emits nor resolves the
    // pricing finding, which is still open on the PR.
    const [pricing] = await fx.db.select({ id: findingsTable.id }).from(findingsTable).where(eq(findingsTable.fingerprint, "fp-callers-break"));
    const pricingOpen = { id: pricing!.id, title: "Callers break", severity: "high" as const, category: "correctness" as const, path: PRICING, startLine: 3 };
    const head2 = fx.push({ "services/billing/tax.ts": "export function taxFor(amount: number) {\n  return 0;\n}\n" });
    out = reviewOutput({
      findings: [engineFinding({ fingerprint: "fp-tax", title: "Tax is always zero", path: "services/billing/tax.ts", severity: "medium", startLine: 2, endLine: 2 })],
      openPriorFindings: [pricingOpen],
    });
    expect(await fx.review(engine.run, { trigger: "synchronize", headSha: head2 })).toMatchObject({ status: "completed", posted: 1 });
    expect(engine.calls[1]!.incremental).toEqual({ sinceSha: fx.head, changedPaths: ["services/billing/tax.ts"] });
    expect(engine.calls[1]!.priorFindings.map((p) => p.id)).toEqual([pricing!.id]);

    // The engine reports the untouched prior finding as still open; the summary counts it with the new one.
    const summary = fx.host.issueComments.get("acme/shop#7")![0]!.body;
    expect(summary).toContain("### Findings (2)");
    expect(summary).toContain("1 high · 1 medium");
    expect(summary).toContain("1 from this review, 1 still open from earlier reviews");
    expect(summary).toContain("| High | `services/billing/pricing.ts:3` | Callers break |");
    expect(summary).not.toContain("No issues found.");
    const [row] = await fx.db.select().from(reviews);
    expect(row).toMatchObject({ openFindings: 2 });

    // Once the pricing finding is resolved and nothing new is found, the summary says so.
    const [tax] = await fx.db.select({ id: findingsTable.id }).from(findingsTable).where(eq(findingsTable.fingerprint, "fp-tax"));
    out = reviewOutput({
      resolvedPriorFindings: [{ id: pricing!.id, reason: "fixed" }],
      findings: [],
      openPriorFindings: [{ id: tax!.id, title: "Tax is always zero", severity: "medium", category: "correctness", path: "services/billing/tax.ts", startLine: 2 }],
    });
    const head3 = fx.push({ [PRICING]: `${HEAD_PRICING}// fixed\n` });
    await fx.review(engine.run, { trigger: "synchronize", headSha: head3 });
    const after = fx.host.issueComments.get("acme/shop#7")![0]!.body;
    expect(after).toContain("### Findings (1)");
    expect(after).not.toContain("Callers break");
    expect(after).toContain("| Medium | `services/billing/tax.ts:2` | Tax is always zero |");
  });
});
