/**
 * The `review-pr` job (R6.6): runs one tracked review run through the state machine.
 *
 *   claim (queued → ingesting) → gates → ingest the PR → build the engine request → engine (stages via onStage)
 *   → publish under the per-PR lock (publishing → completed) → persist findings, aggregates, and usage
 *
 * Concurrency (S30): a run whose head is no longer the PR's head, or for which a newer run exists, ends
 * `superseded`; the publish step re-checks that atomically under a per-PR advisory lock while claiming the PR's
 * publishing slot, so an obsolete run can never publish. The GitHub writes happen after that short transaction
 * commits (no row locks are held across network calls), and a second short transaction stores the results.
 * Cancellation (R6.16) is checked at every stage boundary and before publishing, and a heartbeat poll aborts
 * in-flight model calls through the request's AbortSignal.
 *
 * Failures: a GitHub rate limit or a busy publishing slot puts the run back in the queue until it can go on (no
 * attempt is spent). Any other error puts it back for the queue's next attempt; on the last attempt the run ends
 * `failed`. Tokens and cost always come from the gateway's records for the whole run (every attempt).
 *
 * Indexing vs. reviewing: if the repository is being re-indexed while a review runs, the review reads the last
 * committed index. The indexer writes each file in its own transaction, so the review sees every file either
 * before or after its re-index, never half-written; it does not wait for the index run.
 */
import { count, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { loadEffectiveConfig } from "@/lib/config/repo-config";
import { reviewGate } from "@/lib/config/settings";
import type { Db } from "@/lib/db";
import {
  agentRuns,
  installations,
  orgs,
  pullRequestCommits,
  pullRequests,
  repos,
  reviewComments,
  reviews,
  usageEvents,
} from "@/lib/db/schema";
import { findingCounts, loadHistoricalFindings, loadPriorFindings, type RunScope } from "@/lib/data/findings";
import { activeRulesForRepo } from "@/lib/data/rules";
import { scoped } from "@/lib/data/tenant";
import {
  CancelledError,
  type AgentRunRecord,
  type EngineStage,
  type ExistingComment,
  type ReviewOutput,
  type ReviewRequest,
} from "@/lib/engine/types";
import type { GitHost, PullRequest } from "@/lib/git/types";
import type { RunMeta } from "@/lib/jobs/handlers";
import type { JobPayloads, JobQueue } from "@/lib/jobs/types";
import { rateLimitRetryMs } from "@/lib/jobs/rate-limit";
import { learnedForRepo, syncFeedback } from "@/lib/learning";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import { modelCallTotals } from "@/lib/llm/recorder";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { creditsFor, defaultRunReview, type RunReview } from "@/lib/pipeline/engine";
import { claimPublishSlot } from "@/lib/pipeline/lock";
import { MAX_RUN_ATTEMPTS } from "@/lib/pipeline/recovery";
import { createRun, hasNewerRun, ReviewRequestError } from "@/lib/pipeline/request";
import {
  getRun,
  isTerminal,
  runLogger,
  touchHeartbeat,
  transition,
  IllegalTransitionError,
  RunNotFoundError,
  type RunRow,
  type RunStatus,
} from "@/lib/pipeline/state";
import { loadContextDocs } from "./context-files";
import { fingerprintFromBody, persistPublication, publishReview, SUMMARY_MARKER } from "./publish";

/** Heartbeat (and cancellation poll) interval while a run is active. */
export const HEARTBEAT_MS = 30_000;

export interface ReviewJobDeps {
  db: Db;
  host: GitHost;
  llm: LlmProvider;
  embedder?: EmbeddingProvider;
  queue?: JobQueue;
  log?: Logger;
  /** The review engine (S39); defaults to {@link defaultRunReview}. Tests inject a stub. */
  runReview?: RunReview;
  now?: () => Date;
  heartbeatMs?: number;
  /** How long to wait for the PR's publishing slot while another run of the PR publishes. */
  publishLock?: { waitMs?: number; pollMs?: number };
}

export type ReviewJobPayload = JobPayloads["review-pr"];

export interface ReviewJobResult {
  status: RunStatus;
  runId: number;
  reviewId?: number;
  reason?: string;
  posted?: number;
  skipped?: number;
  resolved?: number;
  findings?: number;
}

/** The run stopped early on purpose (cancelled or superseded); not a failure. */
class RunStopped extends CancelledError {
  constructor(
    readonly outcome: "cancelled" | "superseded",
    reason: string,
  ) {
    super(reason);
    this.name = "RunStopped";
  }
}

/** The run decided not to review (settings, PR state); not a failure. */
class RunSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RunSkipped";
  }
}

/** Errors the worker retries later without spending an attempt (busy lock, GitHub rate limit). */
function deferMs(err: unknown): number | undefined {
  if (err && typeof err === "object" && "retryAfterMs" in err && typeof err.retryAfterMs === "number") return err.retryAfterMs;
  return rateLimitRetryMs(err);
}

/** Errors another attempt cannot fix (bad data, a missing run); every other error is retried by the queue. */
function retryable(err: unknown): boolean {
  return !(err instanceof ZodError || err instanceof ReviewRequestError || err instanceof RunNotFoundError);
}

/** Whether this is the run's last chance: the queue has no attempts left, or the run already started too often. */
function lastAttempt(run: RunRow, queue: Pick<RunMeta, "attemptsMade" | "maxAttempts"> | undefined): boolean {
  if (run.attempts >= MAX_RUN_ATTEMPTS) return true;
  if (queue?.maxAttempts === undefined) return true;
  return (queue.attemptsMade ?? 0) + 1 >= queue.maxAttempts;
}

function prState(pr: PullRequest): "open" | "closed" | "merged" {
  return pr.state === "open" ? "open" : pr.merged ? "merged" : "closed";
}

const toDate = (s: string | null | undefined) => (s ? new Date(s) : null);

/**
 * Runs the `review-pr` job (see the module comment). `payload.runId` names the run; a payload without one (queued
 * before runs existed, or a direct call) gets a run created for it first. `queue` tells which queue attempt this is;
 * without it (direct calls) a failure is final.
 */
export async function runReviewJob(
  deps: ReviewJobDeps,
  payload: ReviewJobPayload,
  queue?: Pick<RunMeta, "attemptsMade" | "maxAttempts">,
): Promise<ReviewJobResult> {
  const { db } = deps;
  const baseLog = deps.log ?? rootLog;
  const clock = deps.now ?? (() => new Date());

  let runId = payload.runId;
  if (runId === undefined) {
    const trigger = payload.trigger && payload.trigger !== "recovery" ? payload.trigger : "manual";
    const { run } = await createRun(
      db,
      { orgId: payload.orgId, repoId: payload.repoId, prNumber: payload.prNumber, headSha: payload.headSha, trigger, meta: payload.meta },
      baseLog,
    );
    runId = run.id;
  }
  const ref = { orgId: payload.orgId, runId };
  const queued = await getRun(db, ref);
  if (!queued) return { status: "skipped", runId, reason: "run not found" };
  if (isTerminal(queued.status)) return { status: queued.status, runId, reviewId: queued.reviewId, reason: queued.statusReason ?? undefined };
  // Another execution owns a run that already started; restart recovery takes over if that one died.
  if (queued.status !== "queued") return { status: queued.status, runId, reviewId: queued.reviewId, reason: "run already in progress" };

  const log = runLogger(queued, baseLog);
  if (queued.cancelRequested) {
    const outcome = (await hasNewerRun(db, queued)) ? "superseded" : "cancelled";
    await finish(db, queued, outcome, queued.statusReason ?? `${outcome} before it started`, log);
    return { status: outcome, runId, reviewId: queued.reviewId };
  }

  let run: RunRow;
  try {
    run = await transition(db, ref, "ingesting", { attempts: queued.attempts + 1 }, { from: "queued", log, now: clock() });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) throw err;
    const current = await getRun(db, ref);
    return { status: current?.status ?? "skipped", runId, reviewId: queued.reviewId, reason: "claimed by another job" };
  }

  const controller = new AbortController();
  const stopIfRequested = async () => {
    const current = await getRun(db, ref);
    if (!current) throw new RunStopped("cancelled", "run deleted");
    if (current.cancelRequested) {
      controller.abort();
      const newer = await hasNewerRun(db, current);
      throw new RunStopped(newer ? "superseded" : "cancelled", newer ? "superseded by a newer run" : (current.statusReason ?? "cancelled"));
    }
  };
  const timer = setInterval(() => {
    void (async () => {
      try {
        await touchHeartbeat(db, ref, clock());
        const current = await getRun(db, ref);
        if (current?.cancelRequested) controller.abort();
      } catch (err) {
        log.warn("review heartbeat failed", { error: errorMessage(err) });
      }
    })();
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref?.();

  try {
    return await execute(deps, run, { log, controller, stopIfRequested, clock });
  } catch (err) {
    if (err instanceof RunSkipped) {
      await finish(db, run, "skipped", err.message, log);
      return { status: "skipped", runId, reviewId: run.reviewId, reason: err.message };
    }
    if (err instanceof RunStopped || err instanceof CancelledError || controller.signal.aborted) {
      let outcome: "cancelled" | "superseded" = err instanceof RunStopped ? err.outcome : "cancelled";
      if (!(err instanceof RunStopped)) outcome = (await hasNewerRun(db, run)) ? "superseded" : "cancelled";
      const reason = err instanceof RunStopped ? err.message : outcome === "superseded" ? "superseded by a newer run" : "cancelled";
      await recordUsage(db, run, { credits: 0 });
      await finish(db, run, outcome, reason, log);
      return { status: outcome, runId, reviewId: run.reviewId, reason };
    }
    const retryMs = deferMs(err);
    if (retryMs !== undefined) {
      // Retried by the worker after the delay; the run waits in the queue meanwhile (its heartbeat is set past the
      // wait so restart recovery does not take it for abandoned).
      await transition(
        db,
        ref,
        "queued",
        { statusReason: `waiting ${Math.round(retryMs / 1000)}s: ${errorMessage(err, 300)}` },
        { log, heartbeatAt: new Date(clock().getTime() + retryMs) },
      ).catch(() => undefined);
      throw err;
    }
    if (retryable(err) && !lastAttempt(run, queue)) {
      // The queue runs the job again after its backoff; the run waits for it in `queued`.
      const requeued = await transition(db, ref, "queued", { statusReason: `retrying after an error: ${errorMessage(err, 300)}` }, { log }).then(
        () => true,
        () => false,
      );
      if (requeued) throw err;
    }
    await recordUsage(db, run, { credits: 0 }).catch(() => undefined);
    await finish(db, run, "failed", errorMessage(err), log).catch((e) => log.error("could not record review failure", { error: errorMessage(e) }));
    throw err;
  } finally {
    clearInterval(timer);
  }
}

/** Ends a run early and mirrors the outcome on the PR's review row when this run is the PR's latest. */
async function finish(db: Db, run: RunRow, to: "skipped" | "cancelled" | "superseded" | "failed", reason: string, log: Logger) {
  const ref = { orgId: run.orgId, runId: run.id };
  try {
    await transition(db, ref, to, to === "failed" ? { error: reason, statusReason: "failed" } : { statusReason: reason }, { log });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) throw err;
    return;
  }
  // Only the PR's latest run speaks for the review row. A run that did not review (skipped, or superseded by a
  // head nobody asked to review) leaves an earlier completed review as it was.
  const status =
    to === "skipped" || to === "superseded" ? sql`case when ${reviews.runs} > 0 then 'completed'::review_status else 'skipped'::review_status end` : to;
  await db
    .update(reviews)
    .set({ status, ...(to === "failed" ? { error: reason } : {}) })
    .where(scoped(reviews, run.orgId, eq(reviews.id, run.reviewId), eq(reviews.lastRunId, run.id)));
}

/** One `usage_events` row per run that reached the model (R6.16): tokens and estimated cost from the gateway's records. */
async function recordUsage(
  db: Db,
  run: RunRow,
  input: { credits: number; author?: string; inputTokens?: number; outputTokens?: number; costUsd?: number | null },
) {
  const totals = await modelCallTotals(db, run.orgId, { reviewRunId: run.id });
  const inputTokens = input.inputTokens ?? totals.inputTokens;
  const outputTokens = input.outputTokens ?? totals.outputTokens;
  if (!input.credits && !inputTokens && !outputTokens) return;
  const costUsd = input.costUsd !== undefined ? input.costUsd : totals.calls - totals.unpricedCalls > 0 ? totals.costUsd : null;
  let author = input.author;
  if (author === undefined) {
    const [pr] = await db
      .select({ author: pullRequests.author })
      .from(pullRequests)
      .where(scoped(pullRequests, run.orgId, eq(pullRequests.repoId, run.repoId), eq(pullRequests.number, run.prNumber)));
    author = pr?.author;
  }
  await db.insert(usageEvents).values({
    orgId: run.orgId,
    repoId: run.repoId,
    reviewRunId: run.id,
    prNumber: run.prNumber,
    author: author || null,
    kind: "review",
    inputTokens,
    outputTokens,
    costUsd,
    credits: input.credits,
  });
}

interface ExecContext {
  log: Logger;
  controller: AbortController;
  stopIfRequested: () => Promise<void>;
  clock: () => Date;
}

async function execute(deps: ReviewJobDeps, run: RunRow, ctx: ExecContext): Promise<ReviewJobResult> {
  const { db } = deps;
  const { log } = ctx;
  const ref = { orgId: run.orgId, runId: run.id };

  const [row] = await db
    .select({ repo: repos, installation: installations, org: orgs })
    .from(repos)
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .innerJoin(orgs, eq(repos.orgId, orgs.id))
    .where(scoped(repos, run.orgId, eq(repos.id, run.repoId)));
  if (!row) throw new RunSkipped("repository not found");
  if (row.repo.archived) throw new RunSkipped("repository archived");
  if (!row.repo.enabled) throw new RunSkipped("reviews disabled for repository");
  if (row.installation.suspended) throw new RunSkipped("installation suspended");
  const { repo } = row;

  const client = deps.host.client(row.installation.externalId);
  const pr = await client.getPullRequest(repo.fullName, run.prNumber);
  if (pr.state !== "open") throw new RunSkipped(`pull request is ${prState(pr)}`);
  if (run.headSha && run.headSha !== pr.headSha) throw new RunStopped("superseded", `head moved to ${pr.headSha.slice(0, 7)}`);
  if (await hasNewerRun(db, run)) throw new RunStopped("superseded", "superseded by a newer run");

  const config = await loadEffectiveConfig(client, repo.fullName, pr.baseSha, repo.settings, row.org.settings);
  const settings = config.settings;
  const gate = reviewGate(settings, { trigger: run.trigger, draft: pr.draft, baseRef: pr.baseRef, headRef: pr.headRef });
  if (gate) throw new RunSkipped(gate);

  // Stage 1: ingestion.
  const [files, commits, issueComments, inlineComments, prReviews, checks] = await Promise.all([
    client.listPullRequestFiles(repo.fullName, pr.number),
    client.listPullRequestCommits(repo.fullName, pr.number),
    client.listIssueComments(repo.fullName, pr.number),
    client.listReviewComments(repo.fullName, pr.number),
    client.listReviews(repo.fullName, pr.number),
    client.listCheckRuns(repo.fullName, pr.headSha),
  ]);
  const [prRow] = await db
    .insert(pullRequests)
    .values({
      orgId: run.orgId,
      repoId: repo.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.author,
      state: prState(pr),
      draft: pr.draft,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      url: pr.url ?? null,
      closedAt: toDate(pr.closedAt),
      mergedAt: toDate(pr.mergedAt),
    })
    .onConflictDoUpdate({
      target: [pullRequests.repoId, pullRequests.number],
      set: {
        title: pr.title,
        body: pr.body,
        author: pr.author,
        state: prState(pr),
        draft: pr.draft,
        baseRef: pr.baseRef,
        headRef: pr.headRef,
        baseSha: pr.baseSha,
        headSha: pr.headSha,
        url: pr.url ?? null,
      },
    })
    .returning();
  if (commits.length) {
    await db
      .insert(pullRequestCommits)
      .values(commits.map((c) => ({ orgId: run.orgId, pullRequestId: prRow!.id, sha: c.sha, message: c.message, author: c.author, committedAt: toDate(c.committedAt) })))
      .onConflictDoNothing();
  }
  const mode = (run.mode as ReviewRequest["mode"] | null) ?? settings.mode;
  await db
    .update(reviews)
    .set({ pullRequestId: prRow!.id, prTitle: pr.title, prAuthor: pr.author, headSha: pr.headSha, status: "running", error: null, mode })
    .where(scoped(reviews, run.orgId, eq(reviews.id, run.reviewId)));

  // Incremental re-review (R1.6): only files changed since the last reviewed head, unless a full review was asked.
  let incremental: ReviewRequest["incremental"];
  const since = prRow!.lastReviewedSha;
  if (since && since !== pr.headSha && !run.full) {
    try {
      const changed = await client.compareCommits(repo.fullName, since, pr.headSha);
      const inPr = new Set(files.map((f) => f.path));
      incremental = { sinceSha: since, changedPaths: changed.map((c) => c.path).filter((p) => inPr.has(p)) };
    } catch (err) {
      log.info("incremental baseline unavailable; reviewing the whole PR", { sinceSha: since, error: errorMessage(err) });
    }
  }
  await transition(db, ref, "ingesting", { headSha: pr.headSha, baseSha: pr.baseSha, sinceSha: incremental?.sinceSha ?? null }, { log });
  await ctx.stopIfRequested();

  const context = await loadContextDocs(client, repo.fullName, pr.baseSha, settings.context);
  await syncFeedback(deps, { orgId: run.orgId, repoId: repo.id, prNumber: pr.number }).catch((err) =>
    log.info("feedback sync before review failed", { error: errorMessage(err) }),
  );
  const [dashboardRules, learned, priors, historical] = await Promise.all([
    activeRulesForRepo(db, run.orgId, repo.id),
    learnedForRepo(db, run.orgId, repo.id),
    loadPriorFindings(db, run.orgId, run.reviewId),
    loadHistoricalFindings(db, run.orgId, { repoId: repo.id, excludeReviewId: run.reviewId, paths: files.map((f) => f.path) }),
  ]);
  const existingComments: ExistingComment[] = [
    ...issueComments
      .filter((c) => !c.body.startsWith(SUMMARY_MARKER))
      .map((c) => ({ id: c.id, author: c.author, body: c.body, fingerprint: null })),
    ...inlineComments.map((c) => ({ id: c.id, author: c.author, body: c.body, path: c.path, line: c.line, fingerprint: fingerprintFromBody(c.body) })),
    // Submitted reviews with a body (a teammate's overall feedback); ours are posted without one.
    ...prReviews
      .filter((r) => r.body.trim() && r.state !== "PENDING")
      .map((r) => ({ id: r.id, author: r.author, body: r.body, fingerprint: null })),
  ];

  const fileCache = new Map<string, Promise<string | null>>();
  const request: ReviewRequest = {
    orgId: run.orgId,
    repo: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch },
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.author,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      ...(pr.url ? { url: pr.url } : {}),
      commits: commits.map((c) => ({ sha: c.sha, message: c.message, author: c.author })),
      checks,
    },
    files,
    readFile: (path, which) => {
      const sha = which === "base" ? pr.baseSha : pr.headSha;
      const key = `${sha}:${path}`;
      let hit = fileCache.get(key);
      if (!hit) {
        hit = client.getFileContent(repo.fullName, path, sha);
        fileCache.set(key, hit);
      }
      return hit;
    },
    mode,
    ...(run.focus === "security" ? { focus: "security" as const } : {}),
    settings: {
      minConfidence: settings.minConfidence,
      minSeverity: settings.minSeverity,
      maxComments: settings.maxComments,
      categories: settings.categories,
      ignoredPaths: settings.ignore,
      customInstructions: settings.customInstructions,
      commentStyle: settings.commentStyle,
      model: settings.model,
    },
    rules: [...dashboardRules, ...config.rules],
    learned: learned.map((l) => ({ category: l.category, description: l.description, signal: l.signal })),
    contextDocs: context.docs.map((d) => ({ path: d.path, content: d.content })),
    existingComments,
    priorFindings: priors,
    historicalFindings: historical,
    ...(incremental ? { incremental } : {}),
    meta: { reviewRunId: run.id },
    signal: ctx.controller.signal,
  };

  const engine = deps.runReview ?? defaultRunReview;
  const output: ReviewOutput = await engine(
    {
      db,
      llm: deps.llm,
      embedder: deps.embedder,
      log,
      hooks: {
        onStage: async (stage: EngineStage) => {
          await ctx.stopIfRequested();
          await transition(db, ref, stage, {}, { log });
        },
        onAgentRun: async (a: AgentRunRecord) => {
          await db.insert(agentRuns).values({
            orgId: run.orgId,
            reviewRunId: run.id,
            agent: a.agent,
            status: a.status,
            model: a.model,
            inputTokens: a.usage.inputTokens,
            outputTokens: a.usage.outputTokens,
            costUsd: a.costUsd,
            latencyMs: Math.round(a.latencyMs),
            candidates: a.candidates,
            accepted: a.accepted,
            error: a.error ?? null,
          });
        },
      },
    },
    request,
  );
  await ctx.stopIfRequested();

  // Claim the PR's publishing slot; the guard makes sure only the newest, uncancelled run publishes (S30).
  const credits = creditsFor(mode);
  const review = await claimPublishSlot(
    db,
    run,
    async (tx) => {
      const current = await getRun(tx, ref);
      if (!current || current.cancelRequested || (await hasNewerRun(tx, current))) {
        const newer = current ? await hasNewerRun(tx, current) : false;
        throw new RunStopped(newer ? "superseded" : "cancelled", newer ? "superseded by a newer run before publishing" : "cancelled before publishing");
      }
      await transition(tx, ref, "publishing", {}, { log });
      const [row] = await tx.select().from(reviews).where(scoped(reviews, run.orgId, eq(reviews.id, run.reviewId)));
      return row!;
    },
    { ...deps.publishLock, now: ctx.clock },
  );

  // GitHub writes, outside any transaction.
  const scope: RunScope = { orgId: run.orgId, repoId: repo.id, reviewId: run.reviewId, prNumber: pr.number, runId: run.id, headSha: pr.headSha };
  const published = await publishReview(
    { db, client, log },
    {
      scope,
      repoFullName: repo.fullName,
      summaryCommentId: review.summaryCommentId,
      reviewNumber: review.runs + 1,
      output,
      notices: [...config.notices, ...context.notices],
      maxComments: settings.maxComments,
      commentStyle: settings.commentStyle,
      existingReviewComments: inlineComments,
    },
  );

  // Store what was published and complete the run, in one short transaction.
  return db.transaction(async (tx) => {
    await persistPublication(tx, scope, published.records);
    // Tokens and cost come from the same source: the gateway's records for the whole run (every attempt), or the
    // engine's own report when the gateway recorded nothing.
    const totals = await modelCallTotals(tx, run.orgId, { reviewRunId: run.id });
    const recorded = totals.calls > 0;
    const inputTokens = recorded ? totals.inputTokens : output.usage.inputTokens;
    const outputTokens = recorded ? totals.outputTokens : output.usage.outputTokens;
    const costUsd = recorded ? (totals.calls > totals.unpricedCalls ? totals.costUsd : null) : output.usage.costUsd;
    const counts = await findingCounts(tx, run.orgId, run.reviewId);
    const [{ comments }] = (await tx
      .select({ comments: count() })
      .from(reviewComments)
      .where(scoped(reviewComments, run.orgId, eq(reviewComments.reviewId, run.reviewId)))) as [{ comments: number }];
    const [latest] = await tx.select({ usage: reviews.usage }).from(reviews).where(scoped(reviews, run.orgId, eq(reviews.id, run.reviewId)));
    const prior = latest?.usage ?? { inputTokens: 0, outputTokens: 0 };
    await tx
      .update(reviews)
      .set({
        status: "completed",
        error: null,
        prTitle: pr.title,
        prAuthor: pr.author,
        headSha: pr.headSha,
        riskLevel: output.summary.riskLevel,
        confidence: output.summary.confidence,
        summary: output.summary.whatChanged.join("\n"),
        summaryCommentId: published.summaryCommentId,
        commentCount: Number(comments),
        creditsUsed: sql`${reviews.creditsUsed} + ${credits}`,
        runs: sql`${reviews.runs} + 1`,
        usage: { inputTokens: prior.inputTokens + inputTokens, outputTokens: prior.outputTokens + outputTokens },
        costUsd: sql`${reviews.costUsd} + ${costUsd ?? 0}`,
        mode,
        openFindings: counts.open,
        resolvedFindings: counts.resolved,
      })
      .where(scoped(reviews, run.orgId, eq(reviews.id, run.reviewId)));
    await tx
      .update(pullRequests)
      .set({ lastReviewedSha: pr.headSha })
      .where(scoped(pullRequests, run.orgId, eq(pullRequests.id, prRow!.id)));
    await recordUsage(tx, run, { credits, author: pr.author, inputTokens, outputTokens, costUsd });
    await transition(
      tx,
      ref,
      "completed",
      {
        statusReason: null,
        classification: output.classification,
        contextStats: { ...output.context, items: output.context.items.slice(0, 200), filesSkipped: output.metadata.filesSkipped },
        summary: output.summary,
        models: output.metadata.models,
        filesReviewed: output.metadata.filesReviewed,
        findingsPublished: published.posted,
        findingsRejected: output.rejected.length,
        findingsResolved: published.resolved,
        inputTokens,
        outputTokens,
        costUsd,
        credits,
      },
      { log },
    );
    log.info("review published", {
      posted: published.posted,
      skipped: published.skipped,
      heldBack: published.heldBack,
      resolved: published.resolved,
      rejected: output.rejected.length,
      incremental: Boolean(incremental),
      credits,
    });
    return {
      status: "completed" as const,
      runId: run.id,
      reviewId: run.reviewId,
      posted: published.posted,
      skipped: published.skipped,
      resolved: published.resolved,
      findings: output.findings.length,
    };
  });
}
