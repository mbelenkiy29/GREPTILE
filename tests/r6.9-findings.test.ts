import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { agentRuns, findings, reviewComments, reviews } from "@/lib/db/schema";
import { listFindings, MAX_REJECTED_PER_RUN, setFindingStatus } from "@/lib/data/findings";
import { updateRepoSettings } from "@/lib/data/installations";
import { getReviewDetail } from "@/lib/data/reviews";
import { pipelineFixture, PRICING } from "./helpers/pipeline";
import { engineFinding, rejectedCandidate, reviewOutput, stubEngine } from "./helpers/stub-engine";
import { HEAD_PRICING } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof pipelineFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const published = (db: Fixture["db"]) => db.select().from(findings).where(eq(findings.visibility, "published")).orderBy(findings.id);

describe("finding model and lifecycle", () => {
  test("R6.9 persists structured findings with every field and links the posted comment", async () => {
    fx = await pipelineFixture();
    const f = engineFinding({ rule: { id: "rule:4", text: "Keep public signatures stable." } });
    const res = await fx.review(stubEngine(() => reviewOutput({ findings: [f] })).run);
    expect(res).toMatchObject({ status: "completed", posted: 1 });

    const [row] = await published(fx.db);
    const comment = fx.host.reviewComments.get("acme/shop#7")![0]!;
    expect(row).toMatchObject({
      orgId: "org_a",
      repoId: fx.repo.id,
      prNumber: 7,
      firstRunId: res.runId,
      lastRunId: res.runId,
      title: "Callers break",
      description: "Two callers still pass one argument.",
      impact: "Checkout throws at runtime.",
      severity: "high",
      category: "correctness",
      agent: "correctness",
      agents: ["correctness", "api_compat"],
      path: PRICING,
      startLine: 3,
      endLine: 3,
      symbol: "computeTotal",
      anchorCode: f.anchorCode,
      commitSha: fx.head,
      firstSeenSha: fx.head,
      evidence: f.evidence,
      suggestedFix: "Give `region` a default value.",
      suggestion: f.suggestion,
      ruleId: "rule:4",
      ruleText: "Keep public signatures stable.",
      verification: f.verification,
      visibility: "published",
      status: "open",
      fingerprint: "fp-callers-break",
      externalCommentId: comment.id,
    });
    expect(row!.confidence).toBeCloseTo(0.9);
    const [posted] = await fx.db.select().from(reviewComments);
    expect(posted).toMatchObject({ findingId: row!.id, externalId: comment.id, category: "correctness", fingerprint: "fp-callers-break" });
    expect(await fx.db.select({ agent: agentRuns.agent, accepted: agentRuns.accepted }).from(agentRuns)).toEqual([{ agent: "correctness", accepted: 1 }]);
    const [review] = await fx.db.select().from(reviews);
    expect(review).toMatchObject({ openFindings: 1, resolvedFindings: 0, commentCount: 1 });
  });

  test("R6.9 re-detection updates the finding instead of duplicating it or the comment", async () => {
    fx = await pipelineFixture();
    let current = engineFinding();
    const engine = stubEngine(() => reviewOutput({ findings: [current] }));
    const first = await fx.review(engine.run);
    const head2 = fx.push({ [PRICING]: `// pricing\n${HEAD_PRICING}` });
    current = engineFinding({ startLine: 4, endLine: 4, confidence: 0.95 });
    const second = await fx.review(engine.run);
    expect(second).toMatchObject({ status: "completed", posted: 0, skipped: 1 });

    const rows = await published(fx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstRunId: first.runId, lastRunId: second.runId, startLine: 4, commitSha: head2, firstSeenSha: fx.head, status: "open" });
    expect(rows[0]!.confidence).toBeCloseTo(0.95);
    expect(fx.host.reviews).toHaveLength(1);
  });

  test("R6.9 a prior finding the engine matched after a line move is not reposted", async () => {
    fx = await pipelineFixture();
    const first = await fx.review(stubEngine(() => reviewOutput({ findings: [engineFinding()] })).run);
    const [prior] = await published(fx.db);
    fx.push({ [PRICING]: `// moved\n${HEAD_PRICING}` });

    // The engine sees the open prior finding and reports the same issue under a new fingerprint at its new line.
    const engine = stubEngine((req) => {
      expect(req.priorFindings).toEqual([expect.objectContaining({ id: prior!.id, fingerprint: "fp-callers-break", startLine: 3 })]);
      return reviewOutput({ findings: [engineFinding({ fingerprint: "fp-moved", startLine: 4, endLine: 4, priorFindingId: prior!.id })] });
    });
    const second = await fx.review(engine.run);
    expect(second).toMatchObject({ posted: 0, skipped: 1 });
    expect(fx.host.reviews).toHaveLength(1);
    const rows = await published(fx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: prior!.id, fingerprint: "fp-callers-break", startLine: 4, lastRunId: second.runId, firstRunId: first.runId });
  });

  test("R6.9 findings fixed by a later commit are marked resolved and their comment is edited, not reposted", async () => {
    fx = await pipelineFixture();
    await fx.review(stubEngine(() => reviewOutput({ findings: [engineFinding(), engineFinding({ fingerprint: "fp-tax", title: "Tax rounding", startLine: 5, endLine: 5 })] })).run);
    const [callers, tax] = await published(fx.db);
    const commentsBefore = fx.host.reviewComments.get("acme/shop#7")!.map((c) => ({ ...c }));
    const head2 = fx.push({ [PRICING]: HEAD_PRICING.replace("region: string", 'region = "default"') });

    const engine = stubEngine(() =>
      reviewOutput({ findings: [engineFinding({ fingerprint: "fp-tax", title: "Tax rounding", startLine: 5, endLine: 5, priorFindingId: tax!.id })], resolvedPriorFindings: [{ id: callers!.id, reason: "default added" }] }),
    );
    const res = await fx.review(engine.run);
    expect(res).toMatchObject({ status: "completed", posted: 0, resolved: 1 });
    expect(fx.host.reviews).toHaveLength(1);

    const edited = fx.host.reviewComments.get("acme/shop#7")!.find((c) => c.id === callers!.externalCommentId)!;
    const original = commentsBefore.find((c) => c.id === callers!.externalCommentId)!;
    expect(edited.body).toBe(`✅ Resolved in ${head2.slice(0, 7)}\n\n${original.body}`);
    expect(fx.host.commentEdits).toHaveLength(1);
    const [resolved] = await fx.db.select().from(findings).where(eq(findings.id, callers!.id));
    expect(resolved).toMatchObject({ status: "resolved", resolution: "fixed", resolvedSha: head2, resolvedAt: expect.any(Date) });
    const [review] = await fx.db.select().from(reviews);
    expect(review).toMatchObject({ openFindings: 1, resolvedFindings: 1 });
    expect(fx.host.issueComments.get("acme/shop#7")![0]!.body).toContain("1 earlier finding resolved");

    // A later run does not edit it again, and a person can reopen or dismiss findings.
    await fx.review(stubEngine(() => reviewOutput({ resolvedPriorFindings: [{ id: callers!.id, reason: "x" }] })).run);
    expect(fx.host.commentEdits).toHaveLength(1);
    expect(await setFindingStatus(fx.db, "org_b", tax!.id, "dismissed")).toBeUndefined();
    expect(await setFindingStatus(fx.db, "org_a", tax!.id, "false_positive")).toMatchObject({ status: "false_positive" });
  });

  test("R6.9 open findings in a file the PR renamed move to the new path", async () => {
    fx = await pipelineFixture();
    await fx.review(stubEngine(() => reviewOutput({ findings: [engineFinding()] })).run);
    const [prior] = await published(fx.db);
    // The engine tracks the prior finding under the renamed path and reports it as still open.
    const moved = "services/billing/totals.ts";
    await fx.review(
      stubEngine(() =>
        reviewOutput({ openPriorFindings: [{ id: prior!.id, title: prior!.title, severity: "high", category: "correctness", path: moved, startLine: 3 }] }),
      ).run,
    );
    const rows = await published(fx.db);
    expect(rows.map((r) => [r.id, r.path, r.status])).toEqual([[prior!.id, moved, "open"]]);
    expect(fx.host.reviews).toHaveLength(1);
    expect(fx.host.issueComments.get("acme/shop#7")![0]!.body).toContain(`| High | \`${moved}:3\` | Callers break |`);
  });

  test("R6.9 rejected candidates are stored with their reasons, capped per run, and never posted", async () => {
    fx = await pipelineFixture();
    const rejected = [
      rejectedCandidate(),
      ...Array.from({ length: 120 }, (_, i) => rejectedCandidate({ title: `Noise ${i}`, startLine: i + 1, stage: "filter", reason: "below threshold" })),
    ];
    const res = await fx.review(stubEngine(() => reviewOutput({ findings: [engineFinding()], rejected })).run);
    expect(res).toMatchObject({ status: "completed", posted: 1 });
    expect(fx.host.reviews[0]!.comments).toHaveLength(1);

    const rows = await fx.db.select().from(findings).where(eq(findings.visibility, "rejected")).orderBy(findings.id);
    expect(rows).toHaveLength(MAX_REJECTED_PER_RUN);
    expect(rows[0]).toMatchObject({
      title: "Possible null dereference",
      description: "items is validated by the caller",
      verification: { verdict: "reject", stage: "verifier", reasons: ["items is validated by the caller"] },
      externalCommentId: null,
    });
    expect(await fx.run(res.runId)).toMatchObject({ findingsPublished: 1, findingsRejected: 121 });

    // The dashboard detail exposes posted findings, rejected candidates, runs, and agent runs, paginated.
    const detail = (await getReviewDetail(fx.db, "org_a", rows[0]!.reviewId, { rejectedLimit: 10 }))!;
    expect(detail.findings.items.map((f) => f.title)).toEqual(["Callers break"]);
    expect(detail.rejected).toMatchObject({ total: 100 });
    expect(detail.rejected.items).toHaveLength(10);
    expect(detail.runHistory).toEqual([expect.objectContaining({ id: res.runId, status: "completed", trigger: "manual", findingsPublished: 1 })]);
    expect(detail.agentRuns).toEqual([expect.objectContaining({ agent: "correctness", candidates: 2, accepted: 1 })]);
    expect(await getReviewDetail(fx.db, "org_b", rows[0]!.reviewId)).toBeUndefined();
    expect((await listFindings(fx.db, "org_b", { reviewId: rows[0]!.reviewId })).total).toBe(0);
  });

  test("R6.9 findings over the comment limit are held back as suppressed and posted once there is room", async () => {
    fx = await pipelineFixture();
    const two = [engineFinding(), engineFinding({ fingerprint: "fp-second", title: "Second issue", startLine: 5, endLine: 5 })];
    const engine = stubEngine(() => reviewOutput({ findings: two }));
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { maxComments: 1 });
    expect(await fx.review(engine.run)).toMatchObject({ posted: 1 });
    const suppressed = await fx.db.select().from(findings).where(eq(findings.visibility, "suppressed"));
    expect(suppressed).toEqual([
      expect.objectContaining({ fingerprint: "fp-second", verification: expect.objectContaining({ heldBack: "over the limit of 1 new comments per review" }) }),
    ]);

    fx.push({ [PRICING]: `${HEAD_PRICING}// more\n` });
    expect(await fx.review(engine.run)).toMatchObject({ posted: 1, skipped: 1 });
    expect((await published(fx.db)).map((f) => f.fingerprint).sort()).toEqual(["fp-callers-break", "fp-second"]);
  });

  test("R6.9 comments already on GitHub whose records were lost are linked again, not reposted", async () => {
    fx = await pipelineFixture();
    const engine = stubEngine(() => reviewOutput({ findings: [engineFinding()] }));
    await fx.review(engine.run);
    const posted = fx.host.reviewComments.get("acme/shop#7")![0]!;
    // As if the transaction storing the publish had failed after GitHub accepted the comment.
    await fx.db.delete(reviewComments);
    await fx.db.delete(findings);

    expect(await fx.review(engine.run)).toMatchObject({ status: "completed", posted: 0, skipped: 1 });
    expect(fx.host.reviews).toHaveLength(1);
    const rows = await published(fx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fingerprint: "fp-callers-break", externalCommentId: posted.id, status: "open" });
  });
});
