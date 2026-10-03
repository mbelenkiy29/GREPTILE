import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  commentFeedback,
  findings,
  indexJobs,
  installations,
  orgs,
  repos,
  reviewComments,
  reviewRuns,
  reviews,
  usageEvents,
  webhookDeliveries,
  EMPTY_INDEX_PROGRESS,
  type StageTiming,
} from "@/lib/db/schema";
import { createTestDb } from "./db";

export const DAY = 86_400_000;

let ext = 70_000;

/** Stage timings for a run that went through `stages` in order, one second each, starting at `start`. */
export function timings(start: Date, stages: string[], open?: string): Record<string, StageTiming> {
  const out: Record<string, StageTiming> = {};
  stages.forEach((s, i) => {
    out[s] = { startedAt: new Date(start.getTime() + i * 1000).toISOString(), ...(s === open ? {} : { durationMs: 1000 }) };
  });
  return out;
}

async function seedOrg(db: Db, orgId: string, name: string, opts: { missing?: string[] } = {}) {
  await db.insert(orgs).values({ id: orgId, name });
  const [inst] = await db
    .insert(installations)
    .values({ orgId, externalId: ++ext, accountLogin: name.toLowerCase(), missingPermissions: opts.missing ?? [], permissions: { metadata: "read" } })
    .returning();
  return inst!;
}

async function addRepo(db: Db, orgId: string, installationId: number, fullName: string, extra: Partial<typeof repos.$inferInsert> = {}) {
  const [row] = await db
    .insert(repos)
    .values({ orgId, installationId, externalId: ++ext, fullName, ...extra })
    .returning();
  return row!;
}

async function addReview(
  db: Db,
  input: {
    orgId: string;
    repoId: number;
    prNumber: number;
    status: (typeof reviews.$inferInsert)["status"];
    mode: string;
    author: string;
    title: string;
    updatedAt: Date;
    run: Partial<typeof reviewRuns.$inferInsert>;
  },
) {
  const [review] = await db
    .insert(reviews)
    .values({
      orgId: input.orgId,
      repoId: input.repoId,
      prNumber: input.prNumber,
      prTitle: input.title,
      prAuthor: input.author,
      headSha: `head${input.prNumber}`.padEnd(40, "0"),
      status: input.status,
      mode: input.mode,
      runs: 1,
      createdAt: input.updatedAt,
    })
    .returning();
  const [run] = await db
    .insert(reviewRuns)
    .values({ orgId: input.orgId, repoId: input.repoId, reviewId: review!.id, prNumber: input.prNumber, trigger: "opened", mode: input.mode, ...input.run })
    .returning();
  await db.update(reviews).set({ lastRunId: run!.id, updatedAt: input.updatedAt }).where(eq(reviews.id, review!.id));
  return { review: { ...review!, lastRunId: run!.id }, run: run! };
}

type FindingInsert = typeof findings.$inferInsert;

async function addFinding(db: Db, r: { orgId: string; repoId: number; reviewId: number; prNumber: number }, f: Partial<FindingInsert> & { title: string; fingerprint: string }) {
  const [row] = await db
    .insert(findings)
    .values({
      orgId: r.orgId,
      repoId: r.repoId,
      reviewId: r.reviewId,
      prNumber: r.prNumber,
      severity: "medium",
      confidence: 0.6,
      category: "correctness",
      agent: "correctness",
      agents: [f.agent ?? "correctness"],
      path: "src/app.ts",
      startLine: 10,
      endLine: 12,
      commitSha: "c0ffee".padEnd(40, "0"),
      firstSeenSha: "c0ffee".padEnd(40, "0"),
      visibility: "published",
      ...f,
    })
    .returning();
  return row!;
}

/**
 * Two orgs with repositories, reviews and runs in several states, findings (published, resolved, rejected, false
 * positive), comment feedback, webhook deliveries, index jobs, and usage — for dashboard data tests. Org B mirrors
 * a little of everything so tenant isolation can be asserted.
 */
export async function dashboardFixture(now: Date = new Date()) {
  const db = await createTestDb();
  const ago = (ms: number) => new Date(now.getTime() - ms);

  // ---- org A
  const instA = await seedOrg(db, "org_a", "Acme", { missing: ["pull_requests:write"] });
  const api = await addRepo(db, "org_a", instA.id, "acme/api", {
    indexStatus: "ready",
    indexedSha: "abc1234".padEnd(40, "0"),
    indexedAt: ago(DAY),
    fileCount: 120,
    symbolCount: 900,
    languages: { TypeScript: 100, SQL: 20 },
    settings: { mode: "deep" },
  });
  const web = await addRepo(db, "org_a", instA.id, "acme/web", { indexStatus: "indexing" });
  const old = await addRepo(db, "org_a", instA.id, "acme/old", { archived: true, enabled: false });

  const pipelineStages = ["queued", "ingesting", "retrieving_context", "reviewing", "verifying", "summarizing", "publishing", "completed"];
  const r1 = await addReview(db, {
    orgId: "org_a",
    repoId: api.id,
    prNumber: 1,
    status: "completed",
    mode: "standard",
    author: "dana",
    title: "Add billing",
    updatedAt: ago(2 * DAY),
    run: {
      status: "completed",
      stageTimings: timings(ago(2 * DAY), pipelineStages),
      queuedAt: ago(2 * DAY),
      startedAt: ago(2 * DAY),
      finishedAt: new Date(ago(2 * DAY).getTime() + 7000),
      models: { review: "model-large", summary: "model-small" },
      findingsPublished: 2,
      findingsRejected: 1,
      costUsd: 0.12,
      summary: {
        overview: "Adds **billing**.",
        whatChanged: ["Adds invoices"],
        affectedAreas: ["billing"],
        riskLevel: "medium",
        riskRationale: "Money paths",
        confidence: 4,
        architectureImpact: null,
        relevantTests: [],
        diagram: null,
      },
    },
  });
  const r2 = await addReview(db, {
    orgId: "org_a",
    repoId: api.id,
    prNumber: 2,
    status: "failed",
    mode: "deep",
    author: "eli",
    title: "Refactor auth",
    updatedAt: ago(DAY),
    run: {
      status: "failed",
      stageTimings: timings(ago(DAY), ["queued", "ingesting", "retrieving_context", "reviewing", "failed"]),
      error: "model timed out",
      statusReason: "engine error",
      queuedAt: ago(DAY),
      startedAt: ago(DAY),
      finishedAt: new Date(ago(DAY).getTime() + 4000),
    },
  });
  const r3 = await addReview(db, {
    orgId: "org_a",
    repoId: web.id,
    prNumber: 3,
    status: "running",
    mode: "fast",
    author: "dana",
    title: "Tweak CSS",
    updatedAt: ago(60_000),
    run: {
      status: "reviewing",
      stageTimings: timings(ago(120_000), ["queued", "ingesting", "reviewing"], "reviewing"),
      queuedAt: ago(120_000),
      startedAt: ago(119_000),
    },
  });

  const scope1 = { orgId: "org_a", repoId: api.id, reviewId: r1.review.id, prNumber: 1 };
  const fCritical = await addFinding(db, scope1, {
    title: "SQL injection in invoice search",
    fingerprint: "f-crit",
    severity: "critical",
    category: "security",
    agent: "security",
    agents: ["security"],
    confidence: 0.92,
    externalCommentId: 555,
    createdAt: ago(2 * DAY),
    evidence: [{ path: "src/search.ts", startLine: 4, endLine: 5, snippet: "db.raw(q)\nreturn rows", note: "User input reaches raw SQL" }],
    suggestedFix: "Use a parameterized query.",
  });
  const fLow = await addFinding(db, scope1, {
    title: "Unused import",
    fingerprint: "f-low",
    severity: "low",
    confidence: 0.5,
    status: "resolved",
    resolvedSha: "beef".padEnd(40, "0"),
    resolution: "fixed",
    createdAt: ago(2 * DAY - 1000),
  });
  const fRejected = await addFinding(db, scope1, {
    title: "Possible null dereference",
    fingerprint: "rej:1",
    severity: "medium",
    confidence: 0.3,
    visibility: "rejected",
    agent: "correctness",
    verification: { verdict: "reject", stage: "verify", reasons: ["the value is checked two lines above"] },
    description: "the value is checked two lines above",
  });
  const fFalse = await addFinding(db, { orgId: "org_a", repoId: api.id, reviewId: r2.review.id, prNumber: 2 }, {
    title: "Token compared without constant time",
    fingerprint: "f-fp",
    severity: "high",
    confidence: 0.7,
    status: "false_positive",
    agent: "correctness",
    agents: ["correctness", "testing"],
    createdAt: ago(DAY),
  });

  const [c1, c2] = await db
    .insert(reviewComments)
    .values([
      { orgId: "org_a", reviewId: r1.review.id, path: "src/search.ts", line: 4, category: "security", severity: "critical", title: fCritical.title, body: "b", fingerprint: "f-crit", headSha: "h", findingId: fCritical.id },
      { orgId: "org_a", reviewId: r1.review.id, path: "src/app.ts", line: 10, category: "correctness", severity: "low", title: fLow.title, body: "b", fingerprint: "f-low", headSha: "h", findingId: fLow.id },
    ])
    .returning();
  await db.insert(commentFeedback).values([
    { orgId: "org_a", reviewCommentId: c1!.id, kind: "thumbs_up", externalId: 1, author: "dana", sentiment: 1 },
    { orgId: "org_a", reviewCommentId: c2!.id, kind: "thumbs_down", externalId: 2, author: "eli", sentiment: -1 },
    { orgId: "org_a", reviewCommentId: c2!.id, kind: "reply", externalId: 3, author: "eli", body: "noise", sentiment: -1 },
  ]);

  const [runningJob] = await db
    .insert(indexJobs)
    .values({
      orgId: "org_a",
      repoId: web.id,
      kind: "full",
      trigger: "install",
      status: "running",
      startedAt: ago(30_000),
      progress: { ...EMPTY_INDEX_PROGRESS, phase: "parse", filesChanged: 10, filesDone: 5, filesTotal: 10 },
    })
    .returning();
  const [failedJob] = await db
    .insert(indexJobs)
    .values({ orgId: "org_a", repoId: api.id, kind: "incremental", trigger: "push", status: "failed", error: "clone failed: 404", queuedAt: ago(3 * DAY), finishedAt: ago(3 * DAY - 5000) })
    .returning();

  await db.insert(webhookDeliveries).values([
    { deliveryId: "d-failed", event: "pull_request", action: "opened", orgId: "org_a", repoId: api.id, repoFullName: "acme/api", status: "failed", error: "GitHub 502", payload: { action: "opened" }, receivedAt: ago(4 * 3600_000) },
    { deliveryId: "d-ok", event: "push", orgId: "org_a", repoId: api.id, repoFullName: "acme/api", status: "accepted", jobs: ["index-1"], receivedAt: ago(5 * 3600_000) },
    { deliveryId: "d-web", event: "push", orgId: "org_a", repoId: web.id, repoFullName: "acme/web", status: "ignored", reason: "not default branch", receivedAt: ago(6 * 3600_000) },
  ]);

  await db.insert(usageEvents).values([
    { orgId: "org_a", repoId: api.id, kind: "review", inputTokens: 1000, outputTokens: 200, costUsd: 0.1, credits: 2, createdAt: now },
    { orgId: "org_a", repoId: api.id, kind: "index", inputTokens: 500, outputTokens: 0, costUsd: null, credits: 0, createdAt: now },
    { orgId: "org_a", repoId: api.id, kind: "review", inputTokens: 9999, outputTokens: 9999, costUsd: 9, credits: 9, createdAt: ago(40 * DAY) },
  ]);

  // ---- org B (must never leak into org A's views)
  const instB = await seedOrg(db, "org_b", "Globex");
  const core = await addRepo(db, "org_b", instB.id, "globex/core", { indexStatus: "failed", indexError: "boom" });
  const rb = await addReview(db, {
    orgId: "org_b",
    repoId: core.id,
    prNumber: 9,
    status: "failed",
    mode: "standard",
    author: "dana",
    title: "Globex change",
    updatedAt: ago(1000),
    run: { status: "failed", error: "b failed", stageTimings: timings(ago(5000), ["queued", "failed"]), queuedAt: ago(5000), finishedAt: ago(4000) },
  });
  await addFinding(db, { orgId: "org_b", repoId: core.id, reviewId: rb.review.id, prNumber: 9 }, { title: "Globex secret", fingerprint: "g1", severity: "critical", category: "security", agent: "security" });
  await db.insert(indexJobs).values({ orgId: "org_b", repoId: core.id, kind: "full", trigger: "install", status: "failed", error: "b index failed" });
  await db.insert(webhookDeliveries).values({ deliveryId: "d-b", event: "push", orgId: "org_b", repoId: core.id, repoFullName: "globex/core", status: "failed", error: "b webhook", payload: {} });
  await db.insert(usageEvents).values({ orgId: "org_b", kind: "review", inputTokens: 77, outputTokens: 7, costUsd: 5, credits: 1, createdAt: now });

  return {
    db,
    now,
    repos: { api, web, old, core },
    reviews: { r1, r2, r3, rb },
    findings: { fCritical, fLow, fRejected, fFalse },
    jobs: { runningJob: runningJob!, failedJob: failedJob! },
  };
}
