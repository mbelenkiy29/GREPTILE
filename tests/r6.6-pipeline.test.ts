import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { GitHubError, GitHubHost } from "@/lib/github/client";
import { reviewRuns, reviews } from "@/lib/db/schema";
import type { JobPayloads, MemoryQueue } from "@/lib/jobs/types";
import { setLogSink } from "@/lib/log";
import { PrLockBusyError } from "@/lib/pipeline/lock";
import { MAX_RUN_ATTEMPTS, recoverStaleRuns } from "@/lib/pipeline/recovery";
import { cancelReview, createRun, requestReview } from "@/lib/pipeline/request";
import { canTransition, IllegalTransitionError, STAGE_ORDER, transition } from "@/lib/pipeline/state";
import { runReviewJob } from "@/lib/review/run";
import { fakeFetch, jsonResponse } from "./helpers/fake-fetch";
import { pipelineFixture, PRICING } from "./helpers/pipeline";
import { engineFinding, reviewOutput, stubEngine } from "./helpers/stub-engine";

type Fixture = Awaited<ReturnType<typeof pipelineFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

/** Payload of a queued `review-pr` job. */
function reviewJob(job: MemoryQueue["jobs"][number] | undefined): JobPayloads["review-pr"] {
  if (!job || job.name !== "review-pr") throw new Error("expected a review-pr job");
  return job.data as JobPayloads["review-pr"];
}

async function captureLogs<T>(fn: () => Promise<T>) {
  const lines: Record<string, unknown>[] = [];
  const restore = setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  const level = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
  try {
    return { result: await fn(), lines };
  } finally {
    restore();
    if (level === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = level;
  }
}

describe("review job state machine", () => {
  test("R6.6 allows only legal transitions and refuses any move after a terminal state", async () => {
    fx = await pipelineFixture();
    expect(canTransition("queued", "ingesting")).toBe(true);
    expect(canTransition("ingesting", "reviewing")).toBe(true); // the engine may skip a stage
    expect(canTransition("reviewing", "ingesting")).toBe(false);
    expect(canTransition("summarizing", "completed")).toBe(false); // completion only through publishing
    expect(canTransition("publishing", "completed")).toBe(true);
    expect(canTransition("reviewing", "skipped")).toBe(false);
    expect(canTransition("reviewing", "queued")).toBe(true); // restart recovery
    for (const terminal of ["completed", "failed", "cancelled", "superseded", "skipped"] as const) {
      expect(STAGE_ORDER.every((s) => !canTransition(terminal, s))).toBe(true);
    }

    const { run } = await createRun(fx.db, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" });
    const ref = { orgId: "org_a", runId: run.id };
    await transition(fx.db, ref, "ingesting");
    await expect(transition(fx.db, ref, "queued", {}, { from: "queued" })).rejects.toBeInstanceOf(IllegalTransitionError);
    await transition(fx.db, ref, "reviewing");
    await expect(transition(fx.db, ref, "retrieving_context")).rejects.toBeInstanceOf(IllegalTransitionError);
    await transition(fx.db, ref, "failed", { error: "boom" });
    await expect(transition(fx.db, ref, "publishing")).rejects.toThrow(/illegal transition failed → publishing/);
    // Another org cannot move the run.
    await expect(transition(fx.db, { orgId: "org_b", runId: run.id }, "cancelled")).rejects.toThrow(/not found/);
    expect(await fx.run(run.id)).toMatchObject({ status: "failed", error: "boom", finishedAt: expect.any(Date) });
  });

  test("R6.6 persists every stage with timings and logs each transition with correlation ids", async () => {
    fx = await pipelineFixture();
    const engine = stubEngine(() => reviewOutput({ findings: [engineFinding()] }));
    const { result, lines } = await captureLogs(() => fx!.review(engine.run));
    expect(result).toMatchObject({ status: "completed", posted: 1 });

    const run = await fx.run(result.runId);
    expect(run).toMatchObject({ status: "completed", attempts: 1, headSha: fx.head, baseSha: fx.base, findingsPublished: 1 });
    expect(Object.keys(run.stageTimings).sort()).toEqual([...STAGE_ORDER].sort());
    for (const stage of STAGE_ORDER) {
      expect(run.stageTimings[stage]).toMatchObject({ startedAt: expect.any(String), durationMs: expect.any(Number) });
    }
    const starts = STAGE_ORDER.map((s) => Date.parse(run.stageTimings[s]!.startedAt));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.finishedAt!.getTime()).toBeGreaterThanOrEqual(run.startedAt!.getTime());

    const transitions = lines.filter((l) => l.msg === "review run transition");
    expect(transitions.map((l) => l.to)).toEqual(STAGE_ORDER.slice(1));
    for (const l of transitions) {
      expect(l).toMatchObject({ reviewRunId: run.id, reviewId: run.reviewId, prNumber: 7, repoId: fx.repo.id, orgId: "org_a" });
    }
  });

  test("R6.6 a queued run is cancelled at once and its job does nothing", async () => {
    fx = await pipelineFixture();
    const requested = await requestReview({ db: fx.db, queue: fx.queue }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" });
    expect(await cancelReview(fx.db, "org_b", requested.runId, "mallory")).toEqual({ status: "not_found", runId: requested.runId });
    expect(await cancelReview(fx.db, "org_a", requested.runId, "user_1")).toEqual({ status: "cancelled", runId: requested.runId });
    expect(await fx.run(requested.runId)).toMatchObject({ status: "cancelled", cancelRequested: true, statusReason: "cancelled by user_1" });

    const engine = stubEngine(() => reviewOutput());
    const res = await runReviewJob(fx.deps(engine.run), { runId: requested.runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 });
    expect(res.status).toBe("cancelled");
    expect(engine.calls).toHaveLength(0);
    expect(fx.host.issueComments.size).toBe(0);
    expect(await cancelReview(fx.db, "org_a", requested.runId, "user_1")).toMatchObject({ status: "already_finished", runStatus: "cancelled" });
  });

  test("R6.6 a cancel request is honored at the next stage boundary and nothing is published", async () => {
    fx = await pipelineFixture();
    let runId = 0;
    const engine = stubEngine(() => reviewOutput({ findings: [engineFinding()] }), {
      reviewing: async () => {
        expect(await cancelReview(fx!.db, "org_a", runId, "user_1")).toEqual({ status: "cancel_requested", runId });
      },
    });
    const requested = await requestReview({ db: fx.db, queue: fx.queue }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" });
    runId = requested.runId;
    const res = await runReviewJob(fx.deps(engine.run), { runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 });
    expect(res).toMatchObject({ status: "cancelled", reason: "cancelled by user_1" });
    expect(engine.stages).toEqual(["ingesting", "retrieving_context", "reviewing"]);
    const run = await fx.run(runId);
    expect(run.status).toBe("cancelled");
    expect(Object.keys(run.stageTimings)).not.toContain("verifying");
    expect(fx.host.issueComments.size).toBe(0);
    expect(fx.host.reviews).toHaveLength(0);
    const [review] = await fx.db.select().from(reviews).where(eq(reviews.id, run.reviewId));
    expect(review?.status).toBe("cancelled");
  });

  test("R6.6 a run cancelled after the engine finished is stopped before publishing", async () => {
    fx = await pipelineFixture();
    let runId = 0;
    const engine = stubEngine(async () => {
      await cancelReview(fx!.db, "org_a", runId, "user_1");
      return reviewOutput({ findings: [engineFinding()] });
    });
    runId = (await requestReview({ db: fx.db, queue: fx.queue }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" })).runId;
    const res = await runReviewJob(fx.deps(engine.run), { runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 });
    expect(res.status).toBe("cancelled");
    expect(engine.stages).toHaveLength(5);
    expect(Object.keys((await fx.run(runId)).stageTimings)).not.toContain("publishing");
    expect(fx.host.issueComments.size).toBe(0);
    expect(fx.host.reviews).toHaveLength(0);
  });

  test("R6.6 a newer head supersedes older runs, queued or running", async () => {
    fx = await pipelineFixture();
    const engine = stubEngine(() => reviewOutput({ findings: [engineFinding()] }));
    const webhook = (headSha: string, trigger: "opened" | "synchronize") =>
      requestReview({ db: fx!.db, queue: fx!.queue, debounceMs: 15_000 }, { orgId: "org_a", repoId: fx!.repo.id, prNumber: 7, headSha, trigger });

    // A queued run is superseded as soon as a newer one is requested; pushes are debounced.
    const first = await webhook(fx.head, "opened");
    const head2 = fx.push({ [PRICING]: "export const x = 1;\n" });
    const second = await webhook(head2, "synchronize");
    expect(await fx.run(first.runId)).toMatchObject({ status: "superseded", statusReason: `superseded by run ${second.runId}` });
    expect(fx.queue.jobs.map((j) => [j.jobId, j.delay])).toEqual([
      [first.jobId, undefined],
      [second.jobId, 15_000],
    ]);
    expect(await runReviewJob(fx.deps(engine.run), reviewJob(fx.queue.jobs[0]))).toMatchObject({ status: "superseded" });

    // A run whose head is no longer the PR's head ends superseded at start.
    const head3 = fx.push({ [PRICING]: "export const x = 2;\n" });
    expect(await runReviewJob(fx.deps(engine.run), reviewJob(fx.queue.jobs[1]))).toMatchObject({
      status: "superseded",
      reason: `head moved to ${head3.slice(0, 7)}`,
    });

    // A running run is asked to stop when a newer run is requested, and ends superseded at its next stage.
    let third = 0;
    const racing = stubEngine(() => reviewOutput({ findings: [engineFinding()] }), {
      retrieving_context: async () => {
        await requestReview({ db: fx!.db, queue: fx!.queue }, { orgId: "org_a", repoId: fx!.repo.id, prNumber: 7, trigger: "manual" });
      },
    });
    third = (await webhook(head3, "synchronize")).runId;
    expect(await runReviewJob(fx.deps(racing.run), { runId: third, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 })).toMatchObject({
      status: "superseded",
    });
    expect(racing.stages).toEqual(["ingesting", "retrieving_context"]);
    expect(fx.host.issueComments.size).toBe(0);
  });

  test("R6.6 webhook deliveries for a head already in flight reuse its run", async () => {
    fx = await pipelineFixture();
    const input = { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head, trigger: "opened" as const };
    const a = await requestReview({ db: fx.db, queue: fx.queue }, input);
    const b = await requestReview({ db: fx.db, queue: fx.queue }, { ...input, trigger: "reopened" });
    expect(b).toEqual({ ...a, deduped: true });
    expect(fx.queue.jobs).toHaveLength(1);
    // A person asking explicitly always gets a fresh run.
    const manual = await requestReview({ db: fx.db, queue: fx.queue }, { ...input, trigger: "manual" });
    expect(manual.runId).not.toBe(a.runId);
    expect(await fx.run(a.runId)).toMatchObject({ status: "superseded" });
  });

  test("R6.6 an obsolete run can never publish, even when a newer run appears after its last check", async () => {
    fx = await pipelineFixture();
    let runId = 0;
    const engine = stubEngine(async () => {
      const [mine] = await fx!.db.select().from(reviewRuns).where(eq(reviewRuns.id, runId));
      // A newer run recorded without touching this one (as a concurrent request racing the publish step would).
      await fx!.db.insert(reviewRuns).values({ orgId: "org_a", repoId: fx!.repo.id, reviewId: mine!.reviewId, prNumber: 7, trigger: "manual" });
      return reviewOutput({ findings: [engineFinding()] });
    });
    runId = (await requestReview({ db: fx.db, queue: fx.queue }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" })).runId;
    const res = await runReviewJob(fx.deps(engine.run), { runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 });
    expect(res).toMatchObject({ status: "superseded", reason: "superseded by a newer run before publishing" });
    expect(fx.host.issueComments.size).toBe(0);
    expect(fx.host.reviews).toHaveLength(0);
    expect(Object.keys((await fx.run(runId)).stageTimings)).not.toContain("publishing");
  });

  test("R6.6 restart recovery re-enqueues stale runs and fails them after 3 attempts", async () => {
    fx = await pipelineFixture();
    const now = new Date("2026-10-03T12:00:00Z");
    const stale = new Date(now.getTime() - 11 * 60_000);
    const fresh = new Date(now.getTime() - 60_000);
    // One run per PR, so none supersedes another.
    const make = async (prNumber: number, status: "reviewing" | "queued" | "ingesting", attempts: number, heartbeatAt: Date) => {
      const { run } = await createRun(fx!.db, { orgId: "org_a", repoId: fx!.repo.id, prNumber, trigger: "manual" });
      await fx!.db.update(reviewRuns).set({ status, attempts, heartbeatAt }).where(eq(reviewRuns.id, run.id));
      return run;
    };
    const crashed = (await make(7, "reviewing", 1, stale)).id;
    const lost = (await make(8, "queued", 0, stale)).id; // its job is gone from the queue
    const exhausted = (await make(9, "ingesting", MAX_RUN_ATTEMPTS, stale)).id;
    const healthy = (await make(10, "reviewing", 1, fresh)).id;
    // Waiting in a backlog (or deferred for a rate limit): its job is still queued, so it is not abandoned.
    const waiting = await make(11, "queued", 0, stale);
    await fx.queue.add("review-pr", { runId: waiting.id, orgId: "org_a", repoId: fx.repo.id, prNumber: 11 }, { jobId: waiting.jobId! });
    // Its job ran out of queue attempts: that counts as an attempt, and this was the last one.
    const gaveUp = await make(12, "queued", MAX_RUN_ATTEMPTS - 1, stale);
    await fx.queue.add("review-pr", { runId: gaveUp.id, orgId: "org_a", repoId: fx.repo.id, prNumber: 12 }, { jobId: gaveUp.jobId! });
    fx.queue.settle(gaveUp.jobId!, "failed");

    const result = await recoverStaleRuns({ db: fx.db, queue: fx.queue, now: () => now, staleMs: 10 * 60_000 });
    expect(result).toEqual({ requeued: [crashed, lost], failed: [exhausted, gaveUp.id] });
    expect(await fx.run(crashed)).toMatchObject({ status: "queued", attempts: 1, statusReason: expect.stringMatching(/^recovered after no heartbeat/) });
    // Re-queuing a run that never started does not use up an attempt.
    expect(await fx.run(lost)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await fx.run(exhausted)).toMatchObject({ status: "failed", error: expect.stringMatching(/abandoned after 3 attempts/) });
    expect(await fx.run(gaveUp.id)).toMatchObject({ status: "failed", attempts: MAX_RUN_ATTEMPTS });
    expect(await fx.run(waiting.id)).toMatchObject({ status: "queued", attempts: 0, heartbeatAt: stale });
    expect((await fx.run(healthy)).status).toBe("reviewing");
    const jobs = fx.queue.jobs.filter((j) => reviewJob(j).trigger === "recovery");
    const suffix = `-rec${now.getTime().toString(36)}`;
    expect(jobs.map((j) => [j.jobId, reviewJob(j).runId])).toEqual([
      [`review-${fx.repo.id}-7-r${crashed}-a1${suffix}`, crashed],
      [`review-${fx.repo.id}-8-r${lost}${suffix}`, lost],
    ]);
    expect((await fx.run(crashed)).jobId).toBe(jobs[0]!.jobId);

    // The recovered run resumes from its recovery job and counts the new start.
    const engine = stubEngine(() => reviewOutput());
    expect(await runReviewJob(fx.deps(engine.run), reviewJob(jobs[0]))).toMatchObject({ status: "completed" });
    expect(await fx.run(crashed)).toMatchObject({ status: "completed", attempts: 2 });
    // Re-queuing refreshed the heartbeats, and the waiting run's job is still queued: a sweep a minute later does nothing.
    expect(await recoverStaleRuns({ db: fx.db, queue: fx.queue, now: () => new Date(now.getTime() + 60_000), staleMs: 10 * 60_000 })).toEqual({
      requeued: [],
      failed: [],
    });
    // Without a queue lookup, a queued run counts as lost only after several stale periods (a backlog is normal).
    const blind = { add: fx.queue.add.bind(fx.queue) };
    const later = new Date(now.getTime() + 20 * 60_000);
    expect((await recoverStaleRuns({ db: fx.db, queue: blind, now: () => later, staleMs: 10 * 60_000 })).requeued).not.toContain(waiting.id);
    const muchLater = new Date(now.getTime() + 2 * 3_600_000);
    expect((await recoverStaleRuns({ db: fx.db, queue: blind, now: () => muchLater, staleMs: 10 * 60_000 })).requeued).toContain(waiting.id);
  });

  test("R6.6 jobs queued before runs existed get a run and are reviewed", async () => {
    fx = await pipelineFixture();
    const engine = stubEngine(() => reviewOutput());
    const res = await runReviewJob(fx.deps(engine.run), { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head, trigger: "opened" });
    expect(res).toMatchObject({ status: "completed" });
    expect(await fx.run(res.runId)).toMatchObject({ trigger: "opened", status: "completed", headSha: fx.head });
  });

  test("R6.6 a transient failure goes back to the queue and the next attempt completes it; the last attempt fails it", async () => {
    fx = await pipelineFixture();
    let failures = 1;
    const engine = stubEngine(() => {
      if (failures-- > 0) throw new Error("GitHub 502 Bad Gateway");
      return reviewOutput({ findings: [engineFinding()] });
    });
    const request = () => requestReview({ db: fx!.db, queue: fx!.queue }, { orgId: "org_a", repoId: fx!.repo.id, prNumber: 7, trigger: "manual" });
    const job = (runId: number) => ({ runId, orgId: "org_a", repoId: fx!.repo.id, prNumber: 7 });

    const { runId } = await request();
    await expect(runReviewJob(fx.deps(engine.run), job(runId), { attemptsMade: 0, maxAttempts: 3 })).rejects.toThrow("GitHub 502");
    expect(await fx.run(runId)).toMatchObject({ status: "queued", attempts: 1, statusReason: expect.stringMatching(/^retrying after an error: GitHub 502/) });
    expect(await runReviewJob(fx.deps(engine.run), job(runId), { attemptsMade: 1, maxAttempts: 3 })).toMatchObject({ status: "completed", posted: 1 });
    expect(await fx.run(runId)).toMatchObject({ status: "completed", attempts: 2 });

    // The queue's last attempt: the run ends failed.
    failures = 1;
    const last = await request();
    await expect(runReviewJob(fx.deps(engine.run), job(last.runId), { attemptsMade: 2, maxAttempts: 3 })).rejects.toThrow("GitHub 502");
    expect(await fx.run(last.runId)).toMatchObject({ status: "failed", error: "GitHub 502 Bad Gateway" });

    // A GitHub rate limit waits in the queue without spending an attempt, and its heartbeat covers the wait.
    const now = new Date("2026-10-03T12:00:00Z");
    const limited = stubEngine(() => {
      throw new GitHubError(403, "API rate limit exceeded", 30 * 60_000);
    });
    const deferred = await request();
    await expect(runReviewJob(fx.deps(limited.run, { now: () => now }), job(deferred.runId), { attemptsMade: 0, maxAttempts: 3 })).rejects.toThrow("rate limit");
    expect(await fx.run(deferred.runId)).toMatchObject({
      status: "queued",
      statusReason: expect.stringMatching(/^waiting 1800s/),
      heartbeatAt: new Date(now.getTime() + 30 * 60_000),
    });
  });

  test("R6.6 a run waits while another run of the PR is publishing, and publishes outside any transaction", async () => {
    fx = await pipelineFixture();
    const { run: peer } = await createRun(fx.db, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" });
    await fx.db.update(reviewRuns).set({ status: "publishing", heartbeatAt: new Date() }).where(eq(reviewRuns.id, peer.id));
    const { runId } = await requestReview({ db: fx.db, queue: fx.queue }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, trigger: "manual" });
    const engine = stubEngine(() => reviewOutput({ findings: [engineFinding()] }));
    const job = { runId, orgId: "org_a", repoId: fx.repo.id, prNumber: 7 };

    const busy = await runReviewJob(fx.deps(engine.run, { publishLock: { waitMs: 0 } }), job, { attemptsMade: 0, maxAttempts: 3 }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(PrLockBusyError);
    expect(await fx.run(runId)).toMatchObject({ status: "queued", statusReason: expect.stringMatching(/^waiting 5s: another run of review/) });
    expect(fx.host.reviews).toHaveLength(0);

    // The other run finished. GitHub writes run outside any transaction: a database write from inside one of them
    // (which would wait forever behind an open transaction on the single test connection) goes through.
    await fx.db.update(reviewRuns).set({ status: "completed" }).where(eq(reviewRuns.id, peer.id));
    const client = fx.host.client.bind(fx.host);
    fx.host.client = () => {
      const c = client();
      return {
        ...c,
        createReview: async (...args: Parameters<typeof c.createReview>) => {
          const touched = fx!.db.update(reviews).set({ updatedAt: new Date() }).where(eq(reviews.id, peer.reviewId));
          await Promise.race([touched, new Promise((_, reject) => setTimeout(() => reject(new Error("publish holds a transaction")), 2_000))]);
          return c.createReview(...args);
        },
      };
    };
    expect(await runReviewJob(fx.deps(engine.run), job, { attemptsMade: 1, maxAttempts: 3 })).toMatchObject({ status: "completed", posted: 1 });
    expect(Object.keys((await fx.run(runId)).stageTimings)).toEqual(expect.arrayContaining(["queued", "publishing", "completed"]));
  });

  test("R6.6 a run whose head moved with no newer run requested leaves the review row settled", async () => {
    fx = await pipelineFixture();
    const engine = stubEngine(() => reviewOutput());
    // Requested for a head the PR has moved past (e.g. a push by a bot the webhook ignores).
    expect(await fx.review(engine.run, { trigger: "opened", headSha: fx.base })).toMatchObject({ status: "superseded" });
    expect((await fx.db.select().from(reviews))[0]).toMatchObject({ status: "skipped", runs: 0 });
    expect(await fx.review(engine.run)).toMatchObject({ status: "completed" });
    expect(await fx.review(engine.run, { trigger: "opened", headSha: fx.base })).toMatchObject({ status: "superseded" });
    expect((await fx.db.select().from(reviews))[0]).toMatchObject({ status: "completed", runs: 1 });
  });

  test("R6.6 teammates' PR review bodies reach the engine as existing comments", async () => {
    fx = await pipelineFixture();
    fx.host.humanReviews.set("acme/shop#7", [
      { id: 77, author: "eli", state: "CHANGES_REQUESTED", body: "Please cover the EU region in tests.", commitId: fx.head, submittedAt: null },
      { id: 78, author: "eli", state: "APPROVED", body: "", commitId: fx.head, submittedAt: null },
    ]);
    const engine = stubEngine(() => reviewOutput());
    await fx.review(engine.run);
    const existing = engine.calls[0]!.existingComments;
    expect(existing).toContainEqual({ id: 77, author: "eli", body: "Please cover the EU region in tests.", fingerprint: null });
    expect(existing.some((c) => c.id === 78)).toBe(false);
  });

  test("R6.6 ingestion reads PR commits, reviews and CI checks from GitHub and edits review comments in place", async () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const http = fakeFetch((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/access_tokens")) return jsonResponse({ token: "ghs_test_token_abcdefghijklmnop", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (path === "/repos/acme/shop/pulls/7/commits") {
        return jsonResponse([{ sha: "c1", commit: { message: "add tax", author: { name: "Dana", date: "2026-10-01T10:00:00Z" } }, author: { login: "dana" } }]);
      }
      if (path === "/repos/acme/shop/pulls/7/reviews") {
        return jsonResponse([{ id: 9, user: { login: "eli" }, state: "APPROVED", body: "lgtm", commit_id: "c1", submitted_at: "2026-10-01T11:00:00Z" }]);
      }
      if (path === "/repos/acme/shop/commits/c1/check-runs") return jsonResponse({ total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] });
      if (path === "/repos/acme/shop/commits/c2/check-runs") return new Response("forbidden", { status: 403 });
      if (path === "/repos/acme/shop/commits/c3/check-runs") {
        return new Response("API rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" } });
      }
      if (path === "/repos/acme/shop/pulls/comments/55" && req.method === "PATCH") {
        return jsonResponse({ id: 55, path: "a.ts", line: 3, body: (req.body as { body: string }).body, user: { login: "openreview[bot]" } });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new GitHubHost({ appId: "1", privateKey: pem, fetch: http.fetch, sleep: async () => undefined }).client(11);
    expect(await client.listPullRequestCommits("acme/shop", 7)).toEqual([{ sha: "c1", message: "add tax", author: "dana", committedAt: "2026-10-01T10:00:00Z" }]);
    expect(await client.listReviews("acme/shop", 7)).toEqual([
      { id: 9, author: "eli", state: "APPROVED", body: "lgtm", commitId: "c1", submittedAt: "2026-10-01T11:00:00Z" },
    ]);
    expect(await client.listCheckRuns("acme/shop", "c1")).toEqual([{ name: "ci", status: "completed", conclusion: "failure" }]);
    // Without the recommended checks permission the review just has no CI context.
    expect(await client.listCheckRuns("acme/shop", "c2")).toEqual([]);
    // A 403 that is a rate limit is not a missing permission: it is rethrown so the job is deferred.
    await expect(client.listCheckRuns("acme/shop", "c3")).rejects.toMatchObject({ status: 403, retryAfterMs: expect.any(Number) });
    expect(await client.updateReviewComment("acme/shop", 55, "✅ Resolved in abc1234")).toMatchObject({ id: 55, body: "✅ Resolved in abc1234" });
    expect(http.requests.find((r) => r.method === "PATCH")?.body).toEqual({ body: "✅ Resolved in abc1234" });
  });
});
