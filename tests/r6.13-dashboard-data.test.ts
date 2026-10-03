import { describe, expect, test } from "vitest";
import { listFailures } from "@/lib/data/activity";
import { searchFindings } from "@/lib/data/findings";
import { runLifecycle } from "@/lib/data/lifecycle";
import { feedbackAcceptance, getOverview, indexProgressFraction } from "@/lib/data/overview";
import { pageWindow } from "@/lib/data/paginate";
import { getRepoDetail, listRepoOverview, unhealthyInstallations } from "@/lib/data/repos";
import { getReviewDetail, listReviewPage } from "@/lib/data/reviews";
import { listDeliveries } from "@/lib/data/deliveries";
import { agentRuns, EMPTY_INDEX_PROGRESS } from "@/lib/db/schema";
import { DAY, dashboardFixture, timings } from "./helpers/dashboard";

describe("dashboard data (R6.13)", () => {
  test("R6.13 overview metrics count repositories, reviews, findings, feedback, activity and usage for one org only", async () => {
    const fx = await dashboardFixture();
    const o = await getOverview(fx.db, "org_a", fx.now);
    expect(o.counts).toEqual({ repos: 3, activeRepos: 2, prsReviewed: 1, findingsCaught: 3 });
    expect(o.bySeverity).toEqual([
      { severity: "critical", count: 1 },
      { severity: "high", count: 1 },
      { severity: "medium", count: 0 },
      { severity: "low", count: 1 },
    ]);
    // c1 net +1 (useful), c2 net -2 (not useful), one finding marked false positive.
    expect(o.feedback).toEqual({ useful: 1, notUseful: 1, falsePositive: 1, acceptanceRate: 1 / 3 });
    expect(o.recentReviews.map((r) => r.prNumber)).toEqual([3, 2, 1]);
    expect(o.activity).toHaveLength(30);
    expect(o.activity.at(-1)!.day).toBe(fx.now.toISOString().slice(0, 10));
    expect(o.activity.reduce((n, d) => n + d.runs, 0)).toBe(3);
    expect(o.activity.reduce((n, d) => n + d.completed, 0)).toBe(1);
    // Usage this month: two org A events this month (the 40-day-old one and org B's are excluded).
    expect(o.usage).toMatchObject({ reviews: 1, inputTokens: 1500, outputTokens: 200, costUsd: 0.1, credits: 2 });
    // In-progress indexing first, with its live job.
    expect(o.indexing[0]).toMatchObject({ fullName: "acme/web", job: { status: "running", kind: "full" } });
    expect(o.indexing.map((r) => r.fullName)).not.toContain("globex/core");

    const b = await getOverview(fx.db, "org_b", fx.now);
    expect(b.counts).toEqual({ repos: 1, activeRepos: 1, prsReviewed: 0, findingsCaught: 1 });
    expect(b.usage.costUsd).toBe(5);
    expect(await feedbackAcceptance(fx.db, "org_b")).toEqual({ useful: 0, notUseful: 0, falsePositive: 0, acceptanceRate: null });
  });

  test("R6.13 repository list shows index status with live progress, review mode, open findings and last review, tenant-scoped and paginated", async () => {
    const fx = await dashboardFixture();
    const page = await listRepoOverview(fx.db, "org_a", { pageSize: 2 });
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2, pageCount: 2 });
    expect(page.items.map((r) => r.fullName)).toEqual(["acme/api", "acme/old"]);
    const api = page.items[0]!;
    expect(api).toMatchObject({ accountLogin: "acme", indexStatus: "ready", reviewMode: "deep", reviewModeSource: "repo", openFindings: 1, indexJob: null });
    expect(api.lastReview).toMatchObject({ prNumber: 2, status: "failed" });

    const second = await listRepoOverview(fx.db, "org_a", { page: 2, pageSize: 2 });
    const web = second.items[0]!;
    expect(web).toMatchObject({ fullName: "acme/web", reviewMode: "standard", reviewModeSource: "default" });
    expect(web.indexJob).toMatchObject({ id: fx.jobs.runningJob.id, status: "running", progress: { phase: "parse", filesDone: 5, filesChanged: 10 } });
    expect(indexProgressFraction(web.indexJob!.progress)).toBeCloseTo(0.55);
    expect(indexProgressFraction({ ...EMPTY_INDEX_PROGRESS, phase: "done" })).toBe(1);

    expect((await listRepoOverview(fx.db, "org_a", { q: "WEB" })).items.map((r) => r.fullName)).toEqual(["acme/web"]);
    expect((await listRepoOverview(fx.db, "org_a", { q: "%" })).items).toEqual([]);
    expect((await listRepoOverview(fx.db, "org_b")).items.map((r) => r.fullName)).toEqual(["globex/core"]);

    const detail = await getRepoDetail(fx.db, "org_a", fx.repos.api.id);
    expect(detail).toMatchObject({ reviewMode: "deep", stats: { reviews: 2, openFindings: 1, resolvedFindings: 1 }, installation: { missingPermissions: ["pull_requests:write"] } });
    expect(await getRepoDetail(fx.db, "org_b", fx.repos.api.id)).toBeUndefined();
    expect((await unhealthyInstallations(fx.db, "org_a")).map((i) => i.missingPermissions)).toEqual([["pull_requests:write"]]);
    expect(await unhealthyInstallations(fx.db, "org_b")).toEqual([]);
  });

  test("R6.13 reviews list filters by repository, status and mode and paginates", async () => {
    const fx = await dashboardFixture();
    const all = await listReviewPage(fx.db, "org_a");
    expect(all.total).toBe(3);
    expect(all.items.map((r) => r.prNumber)).toEqual([3, 2, 1]);
    const first = all.items.find((r) => r.prNumber === 1)!;
    expect(first).toMatchObject({ repoFullName: "acme/api", prAuthor: "dana", findings: 2, highestSeverity: "critical", status: "completed" });
    expect(first.lastRun).toMatchObject({ status: "completed", models: { review: "model-large", summary: "model-small" } });
    expect(first.lastRun!.finishedAt!.getTime() - first.lastRun!.startedAt!.getTime()).toBe(7000);

    expect((await listReviewPage(fx.db, "org_a", { repoId: fx.repos.web.id })).items.map((r) => r.prNumber)).toEqual([3]);
    expect((await listReviewPage(fx.db, "org_a", { status: "failed" })).items.map((r) => r.prNumber)).toEqual([2]);
    expect((await listReviewPage(fx.db, "org_a", { mode: "fast" })).items.map((r) => r.prNumber)).toEqual([3]);
    expect((await listReviewPage(fx.db, "org_a", { repoId: fx.repos.api.id, status: "completed" })).total).toBe(1);

    const p2 = await listReviewPage(fx.db, "org_a", { page: 2, pageSize: 2 });
    expect(p2).toMatchObject({ total: 3, page: 2, pageCount: 2 });
    expect(p2.items.map((r) => r.prNumber)).toEqual([1]);

    // Another org's repository id as a filter returns nothing, and org B sees only its own.
    expect((await listReviewPage(fx.db, "org_b", { repoId: fx.repos.api.id })).total).toBe(0);
    expect((await listReviewPage(fx.db, "org_b")).items.map((r) => r.repoFullName)).toEqual(["globex/core"]);
    expect(pageWindow({ page: -3, pageSize: 1000 })).toEqual({ page: 1, pageSize: 100, offset: 0 });
  });

  test("R6.13 review detail includes the run lifecycle and rejected candidates with stage and reason", async () => {
    const fx = await dashboardFixture();
    const d = (await getReviewDetail(fx.db, "org_a", fx.reviews.r1.review.id))!;
    expect(d.runHistory).toHaveLength(1);
    expect(d.runHistory[0]!.summary).toMatchObject({ overview: "Adds **billing**.", riskLevel: "medium", confidence: 4 });
    expect(runLifecycle(d.runHistory[0]!).map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "done", "done", "ok"]);
    expect(d.findings.items.map((f) => f.title).sort()).toEqual(["SQL injection in invoice search", "Unused import"]);
    expect(d.rejected.total).toBe(1);
    expect(d.rejected.items[0]).toMatchObject({ title: "Possible null dereference", verification: { stage: "verify", reasons: ["the value is checked two lines above"] } });

    const failed = (await getReviewDetail(fx.db, "org_a", fx.reviews.r2.review.id))!;
    const steps = runLifecycle(failed.runHistory[0]!);
    expect(steps.map((s) => [s.stage, s.state])).toEqual([
      ["queued", "done"],
      ["ingesting", "done"],
      ["retrieving_context", "done"],
      ["reviewing", "interrupted"],
      ["verifying", "pending"],
      ["summarizing", "pending"],
      ["publishing", "pending"],
      ["failed", "failed"],
    ]);
    expect(steps.at(-1)!.detail).toBe("engine error — model timed out");

    expect(await getReviewDetail(fx.db, "org_b", fx.reviews.r1.review.id)).toBeUndefined();

    // Agent runs of a selected run; a run of another review cannot be selected.
    await fx.db.insert(agentRuns).values({ orgId: "org_a", reviewRunId: fx.reviews.r2.run.id, agent: "security", status: "error", error: "timeout", latencyMs: 30_000 });
    const withAgents = (await getReviewDetail(fx.db, "org_a", fx.reviews.r2.review.id, { runId: fx.reviews.r2.run.id }))!;
    expect(withAgents.agentRuns.map((a) => [a.agent, a.status, a.error])).toEqual([["security", "error", "timeout"]]);
    expect((await getReviewDetail(fx.db, "org_a", fx.reviews.r1.review.id, { runId: fx.reviews.r2.run.id }))!.agentRuns).toEqual([]);
  });

  test("R6.13 run lifecycle marks skipped stages and the stage in progress", () => {
    const now = new Date("2026-05-01T00:00:10Z");
    const start = new Date("2026-05-01T00:00:00Z");
    const running = runLifecycle({ status: "reviewing", statusReason: null, error: null, stageTimings: timings(start, ["queued", "ingesting", "reviewing"], "reviewing") }, now);
    expect(running.map((s) => s.state)).toEqual(["done", "done", "skipped", "current", "pending", "pending", "pending", "pending"]);
    expect(running[3]!.durationMs).toBe(8000);
    const cancelled = runLifecycle({ status: "cancelled", statusReason: "cancelled by usr_1", error: null, stageTimings: timings(start, ["queued", "cancelled"]) }, now);
    expect(cancelled.at(-1)).toMatchObject({ stage: "cancelled", state: "stopped", detail: "cancelled by usr_1" });
    expect(cancelled[0]!.state).toBe("interrupted");
  });

  test("R6.13 findings search applies each filter and sort, scoped to the org", async () => {
    const fx = await dashboardFixture();
    const ids = async (f: Parameters<typeof searchFindings>[2]) => (await searchFindings(fx.db, "org_a", f)).items.map((x) => x.title);
    // Default: published only, newest first; rejected candidates and org B's findings never appear.
    expect(await ids({})).toEqual(["Token compared without constant time", "Unused import", "SQL injection in invoice search"]);
    expect(await ids({ repoId: fx.repos.web.id })).toEqual([]);
    expect(await ids({ repoId: fx.repos.core.id })).toEqual([]);
    expect(await ids({ severity: ["critical", "high"] })).toEqual(["Token compared without constant time", "SQL injection in invoice search"]);
    expect(await ids({ category: ["security"] })).toEqual(["SQL injection in invoice search"]);
    expect(await ids({ status: ["resolved"] })).toEqual(["Unused import"]);
    expect(await ids({ author: "ELI" })).toEqual(["Token compared without constant time"]);
    expect(await ids({ agent: "testing" })).toEqual(["Token compared without constant time"]);
    expect(await ids({ from: new Date(fx.now.getTime() - 1.5 * DAY) })).toEqual(["Token compared without constant time"]);
    expect(await ids({ to: new Date(fx.now.getTime() - 1.5 * DAY) })).toEqual(["Unused import", "SQL injection in invoice search"]);
    expect(await ids({ sort: "severity" })).toEqual(["SQL injection in invoice search", "Token compared without constant time", "Unused import"]);
    expect(await ids({ sort: "severity", dir: "asc" })).toEqual(["Unused import", "Token compared without constant time", "SQL injection in invoice search"]);
    expect(await ids({ sort: "confidence", dir: "asc" })).toEqual(["Unused import", "Token compared without constant time", "SQL injection in invoice search"]);
    expect(await ids({ visibility: ["rejected"] })).toEqual(["Possible null dereference"]);
    const page = await searchFindings(fx.db, "org_a", { pageSize: 1, page: 2 });
    expect(page).toMatchObject({ total: 3, pageCount: 3 });
    expect(page.items[0]).toMatchObject({ title: "Unused import", repoFullName: "acme/api", prAuthor: "dana" });
    expect((await searchFindings(fx.db, "org_b")).items.map((x) => x.title)).toEqual(["Globex secret"]);
  });

  test("R6.13 activity feed merges failed deliveries, index runs and review runs newest first", async () => {
    const fx = await dashboardFixture();
    const feed = await listFailures(fx.db, "org_a");
    expect(feed.items.map((i) => [i.kind, i.repoFullName, i.error])).toEqual([
      ["delivery", "acme/api", "GitHub 502"],
      ["review", "acme/api", "model timed out"],
      ["index", "acme/api", "clone failed: 404"],
    ]);
    expect(feed.items[0]).toMatchObject({ replayable: true, href: "/dashboard/activity/d-failed" });
    expect(feed.items[1]!.href).toBe(`/dashboard/reviews/${fx.reviews.r2.review.id}`);
    expect(feed.total).toBe(3);
    expect((await listFailures(fx.db, "org_a", { kind: "index" })).items.map((i) => i.id)).toEqual([String(fx.jobs.failedJob.id)]);
    expect((await listFailures(fx.db, "org_a", { repoId: fx.repos.web.id })).total).toBe(0);
    const p2 = await listFailures(fx.db, "org_a", { page: 2, pageSize: 2 });
    expect(p2.items.map((i) => i.kind)).toEqual(["index"]);
    expect((await listFailures(fx.db, "org_b")).items.map((i) => i.error).sort()).toEqual(["b failed", "b index failed", "b webhook"]);

    const repoDeliveries = await listDeliveries(fx.db, "org_a", { repoId: fx.repos.web.id });
    expect(repoDeliveries.items.map((d) => d.deliveryId)).toEqual(["d-web"]);
    expect((await listDeliveries(fx.db, "org_b", { repoId: fx.repos.web.id })).total).toBe(0);
  });
});
