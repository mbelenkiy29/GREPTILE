/**
 * Knowledge refresh (R6.12): the `refresh-knowledge` job. Each run is a tracked `knowledge_runs` row.
 *
 *   checks (knowledge enabled, repository indexed, the organization's model configured; otherwise `skipped` with
 *   the reason) → claim (one running run per repository) → discover subsystems → sync entries (new subsystems get
 *   entries, entries whose files changed / joined / left are marked stale, vanished generated entries are removed)
 *   → regenerate at most KNOWLEDGE_MAX_ENTRIES_PER_RUN stale entries → record usage → queue a follow-up run when
 *   stale entries remain.
 *
 * An index run that completes with changes queues a refresh (`afterIndexCompleted`); the first one generates every
 * entry (over several runs when there are more than the cap). Edited entries keep their text: a regenerated
 * description is stored as a proposal for a person to accept or reject.
 */
import { asc, eq, inArray, lt, sql } from "drizzle-orm";
import { isUniqueViolation } from "@/lib/data/orgs";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { knowledgeEntries, knowledgeRuns, repos, usageEvents } from "@/lib/db/schema";
import { costOf } from "@/lib/engine/calls";
import { knowledgeEnv, type KnowledgeEnv } from "@/lib/env";
import type { JobMeta, JobQueue } from "@/lib/jobs/types";
import type { LlmProvider } from "@/lib/llm";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { discoverSubsystems, MAX_RELATED_FILES, type Subsystem } from "./discover";
import { generateEntry, knownPaths } from "./generate";

export type KnowledgeRun = typeof knowledgeRuns.$inferSelect;
export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type KnowledgeTrigger = KnowledgeRun["trigger"];
export type KnowledgeMode = KnowledgeRun["mode"];

/** A `running` run older than this was left by a worker that stopped; it no longer blocks new runs. */
export const STALE_RUN_MS = 30 * 60_000;
/** Delay before a run that found another one running tries again. */
export const BUSY_RETRY_MS = 30_000;
/** Delay before the follow-up run that picks up stale entries beyond the per-run cap. */
export const CONTINUE_DELAY_MS = 30_000;

/** Another refresh of the repository is running; the queue runs the job again later without spending an attempt. */
export class KnowledgeBusyError extends Error {
  readonly retryAfterMs = BUSY_RETRY_MS;
  constructor(repoId: number) {
    super(`another knowledge refresh of repository ${repoId} is running`);
    this.name = "KnowledgeBusyError";
  }
}

export interface KnowledgeDeps {
  db: Db;
  llm: LlmProvider;
  queue?: JobQueue;
  log?: Logger;
  now?: () => Date;
  /** Defaults to the process env (`knowledgeEnv()`). */
  env?: KnowledgeEnv;
}

export interface QueueRefreshInput {
  orgId: string;
  repoId: number;
  trigger: KnowledgeTrigger;
  mode?: KnowledgeMode;
  /** For `mode: "entry"`: the entry to regenerate. */
  slug?: string;
  indexJobId?: number;
  meta?: JobMeta;
  delayMs?: number;
}

/**
 * Creates a tracked run and queues the `refresh-knowledge` job for it. The repository must belong to `orgId`. A run
 * whose job could not be queued is marked failed, so no run waits for a worker that will never come.
 */
export async function queueKnowledgeRefresh(db: Db, queue: JobQueue, input: QueueRefreshInput): Promise<KnowledgeRun> {
  const [repo] = await db.select({ id: repos.id }).from(repos).where(scoped(repos, input.orgId, eq(repos.id, input.repoId)));
  if (!repo) throw new Error(`repo ${input.repoId} not found for org ${input.orgId}`);
  const [run] = await db
    .insert(knowledgeRuns)
    .values({
      orgId: input.orgId,
      repoId: input.repoId,
      trigger: input.trigger,
      mode: input.mode ?? "auto",
      slug: input.mode === "entry" ? (input.slug ?? null) : null,
      indexJobId: input.indexJobId ?? null,
      requestedBy: input.meta?.requestedBy ?? null,
    })
    .returning();
  try {
    await queue.add(
      "refresh-knowledge",
      { orgId: input.orgId, repoId: input.repoId, runId: run!.id, ...(input.meta ? { meta: input.meta } : {}) },
      { jobId: `knowledge-${input.repoId}-run-${run!.id}`, ...(input.delayMs ? { delay: input.delayMs } : {}) },
    );
  } catch (err) {
    await db
      .update(knowledgeRuns)
      .set({ status: "failed", reason: `could not queue the refresh: ${errorMessage(err)}`, finishedAt: new Date() })
      .where(scoped(knowledgeRuns, input.orgId, eq(knowledgeRuns.id, run!.id)));
    throw err;
  }
  return run!;
}

/**
 * Queues a knowledge refresh after an index run (R6.12): when the run completed and changed files (or was a full
 * index), and knowledge is enabled. Failures are logged, never thrown: the index itself succeeded.
 */
export async function afterIndexCompleted(
  deps: { db: Db; queue: JobQueue; log?: Logger; env?: KnowledgeEnv },
  job: { orgId: string; repoId: number; meta?: JobMeta },
  result: { status: string; kind: string; indexJobId: number; filesParsed: number; filesRemoved: number },
): Promise<KnowledgeRun | null> {
  const logger = deps.log ?? rootLog;
  if (result.status !== "completed") return null;
  if (result.kind !== "full" && result.filesParsed + result.filesRemoved === 0) return null;
  if (!(deps.env ?? knowledgeEnv()).KNOWLEDGE_ENABLED) return null;
  try {
    return await queueKnowledgeRefresh(deps.db, deps.queue, { orgId: job.orgId, repoId: job.repoId, trigger: "index", indexJobId: result.indexJobId, meta: job.meta });
  } catch (err) {
    logger.warn("could not queue the knowledge refresh after indexing", { orgId: job.orgId, repoId: job.repoId, indexJobId: result.indexJobId, error: errorMessage(err) });
    return null;
  }
}

/** Why the organization's model cannot serve `knowledge` calls, or null when it can. */
export function llmUnavailableReason(llm: LlmProvider): string | null {
  const check = (llm as { configurationError?: (task: "knowledge") => string | null }).configurationError;
  return typeof check === "function" ? check.call(llm, "knowledge") : null;
}

export interface KnowledgeRunResult {
  runId: number;
  status: "completed" | "skipped" | "failed";
  reason?: string;
  discovered: number;
  markedStale: number;
  generated: number;
  failed: number;
  remaining: number;
}

async function finishRun(db: Db, run: KnowledgeRun, patch: Partial<typeof knowledgeRuns.$inferInsert>, now: Date): Promise<KnowledgeRun> {
  const [row] = await db
    .update(knowledgeRuns)
    .set({ ...patch, finishedAt: now })
    .where(scoped(knowledgeRuns, run.orgId, eq(knowledgeRuns.repoId, run.repoId), eq(knowledgeRuns.id, run.id)))
    .returning();
  return row!;
}

function resultOf(run: KnowledgeRun): KnowledgeRunResult {
  return {
    runId: run.id,
    status: run.status === "completed" || run.status === "skipped" ? run.status : "failed",
    ...(run.reason ? { reason: run.reason } : {}),
    discovered: run.discovered,
    markedStale: run.markedStale,
    generated: run.generated,
    failed: run.failed,
    remaining: run.remaining,
  };
}

/** Marks runs of the repository left `running` by a stopped worker as failed. */
async function failAbandonedRuns(db: Db, orgId: string, repoId: number, now: Date) {
  await db
    .update(knowledgeRuns)
    .set({ status: "failed", reason: "interrupted: the worker running this refresh stopped before it finished", finishedAt: now })
    .where(scoped(knowledgeRuns, orgId, eq(knowledgeRuns.repoId, repoId), eq(knowledgeRuns.status, "running"), lt(knowledgeRuns.startedAt, new Date(now.getTime() - STALE_RUN_MS))));
}

/** Runs one tracked knowledge refresh (the `refresh-knowledge` job). */
export async function refreshKnowledge(deps: KnowledgeDeps, job: { orgId: string; repoId: number; runId: number }): Promise<KnowledgeRunResult> {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const cfg = deps.env ?? knowledgeEnv();
  const logger = (deps.log ?? rootLog).child({ component: "knowledge", orgId: job.orgId, repoId: job.repoId, knowledgeRunId: job.runId });

  const [run] = await db.select().from(knowledgeRuns).where(scoped(knowledgeRuns, job.orgId, eq(knowledgeRuns.repoId, job.repoId), eq(knowledgeRuns.id, job.runId)));
  if (!run) throw new Error(`knowledge run ${job.runId} not found for repo ${job.repoId}`);
  // A redelivered job whose run already ended is a no-op.
  if (run.status === "completed" || run.status === "skipped") return resultOf(run);
  const [repo] = await db.select().from(repos).where(scoped(repos, job.orgId, eq(repos.id, job.repoId)));
  if (!repo) throw new Error(`repo ${job.repoId} not found for org ${job.orgId}`);

  const skip = async (reason: string) => {
    logger.info("knowledge refresh skipped", { reason });
    return resultOf(await finishRun(db, run, { status: "skipped", reason }, now()));
  };
  if (!cfg.KNOWLEDGE_ENABLED) return skip("the knowledge base is turned off (KNOWLEDGE_ENABLED=false)");
  if (!repo.indexedSha) return skip("the repository has not been indexed yet");
  const llmProblem = llmUnavailableReason(deps.llm);
  if (llmProblem) return skip(`the organization's model is not configured: ${llmProblem}`);

  // Claim: at most one running run per repository (partial unique index).
  await failAbandonedRuns(db, job.orgId, job.repoId, now());
  let claimed: KnowledgeRun | undefined;
  try {
    [claimed] = await db
      .update(knowledgeRuns)
      .set({ status: "running", startedAt: now(), finishedAt: null, reason: null, sha: repo.indexedSha })
      .where(scoped(knowledgeRuns, run.orgId, eq(knowledgeRuns.repoId, run.repoId), eq(knowledgeRuns.id, run.id), inArray(knowledgeRuns.status, ["queued", "failed"])))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err, "knowledge_runs_one_running_uq")) throw new KnowledgeBusyError(job.repoId);
    throw err;
  }
  if (!claimed) throw new KnowledgeBusyError(job.repoId);

  try {
    return await execute(deps, { run: claimed, repo, cfg, logger, now });
  } catch (err) {
    const reason = errorMessage(err);
    logger.error("knowledge refresh failed", { error: reason });
    await finishRun(db, claimed, { status: "failed", reason }, now());
    throw err;
  }
}

interface ExecContext {
  run: KnowledgeRun;
  repo: typeof repos.$inferSelect;
  cfg: KnowledgeEnv;
  logger: Logger;
  now: () => Date;
}

async function execute(deps: KnowledgeDeps, ctx: ExecContext): Promise<KnowledgeRunResult> {
  const { db } = deps;
  const { run, repo, logger } = ctx;
  const scope = { orgId: repo.orgId, repoId: repo.id };
  const sha = repo.indexedSha!;

  const subsystems = await discoverSubsystems(db, scope);
  const bySlug = new Map(subsystems.map((s) => [s.slug, s]));
  const existing = await db.select().from(knowledgeEntries).where(scoped(knowledgeEntries, scope.orgId, eq(knowledgeEntries.repoId, scope.repoId)));
  const existingBySlug = new Map(existing.map((e) => [e.slug, e]));
  let markedStale = 0;

  // Sync entries with the discovered subsystems.
  for (const sub of subsystems) {
    const entry = existingBySlug.get(sub.slug);
    if (!entry) {
      await db
        .insert(knowledgeEntries)
        .values({
          orgId: scope.orgId,
          repoId: scope.repoId,
          slug: sub.slug,
          title: sub.title,
          kind: sub.kind,
          rank: sub.rank,
          relatedFiles: sub.files.slice(0, MAX_RELATED_FILES),
          dependencies: sub.dependencies,
          facts: factsOf(sub),
          stale: true,
        })
        .onConflictDoNothing({ target: [knowledgeEntries.repoId, knowledgeEntries.slug] });
      markedStale++;
      continue;
    }
    const forced = run.mode === "all" || (run.mode === "entry" && run.slug === sub.slug);
    const changed = entry.sourceFingerprint !== sub.fingerprint;
    const stale = entry.stale || forced || changed;
    if (stale && !entry.stale) markedStale++;
    if (stale !== entry.stale || entry.rank !== sub.rank || entry.title !== sub.title || entry.kind !== sub.kind) {
      await db
        .update(knowledgeEntries)
        .set({ stale, rank: sub.rank, title: sub.title, kind: sub.kind })
        .where(scoped(knowledgeEntries, scope.orgId, eq(knowledgeEntries.repoId, scope.repoId), eq(knowledgeEntries.id, entry.id)));
    }
  }
  // Subsystems that no longer exist: generated entries go; edited ones stay (stale) so no one's text is lost.
  const vanished = existing.filter((e) => !bySlug.has(e.slug));
  const drop = vanished.filter((e) => e.source === "generated").map((e) => e.id);
  if (drop.length) await db.delete(knowledgeEntries).where(scoped(knowledgeEntries, scope.orgId, eq(knowledgeEntries.repoId, scope.repoId), inArray(knowledgeEntries.id, drop)));
  const orphaned = vanished.filter((e) => e.source === "edited" && !e.stale).map((e) => e.id);
  if (orphaned.length) {
    await db
      .update(knowledgeEntries)
      .set({ stale: true, lastError: "this subsystem is no longer found in the index" })
      .where(scoped(knowledgeEntries, scope.orgId, eq(knowledgeEntries.repoId, scope.repoId), inArray(knowledgeEntries.id, orphaned)));
    markedStale += orphaned.length;
  }

  // Pick the stale entries to regenerate: the requested one, then never-generated ones, then by rank.
  const staleRows = await db
    .select()
    .from(knowledgeEntries)
    .where(scoped(knowledgeEntries, scope.orgId, eq(knowledgeEntries.repoId, scope.repoId), eq(knowledgeEntries.stale, true)))
    .orderBy(sql`${knowledgeEntries.lastUpdatedAt} is not null`, asc(knowledgeEntries.rank), asc(knowledgeEntries.id));
  const regenerable = staleRows.filter((e) => bySlug.has(e.slug));
  regenerable.sort((a, b) => Number(b.slug === run.slug) - Number(a.slug === run.slug));
  const batch = regenerable.slice(0, ctx.cfg.KNOWLEDGE_MAX_ENTRIES_PER_RUN);

  const known = batch.length ? await knownPaths(db, scope) : null;
  let generated = 0;
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let calls = 0;
  for (const entry of batch) {
    // Stop early when the model keeps failing: do not spend calls that cannot succeed.
    if (failed >= 2 && generated === 0) break;
    const sub = bySlug.get(entry.slug)!;
    try {
      const out = await generateEntry({ db, llm: deps.llm }, scope, sub, { repoFullName: repo.fullName, sha, known: known! });
      calls++;
      inputTokens += out.usage.inputTokens;
      outputTokens += out.usage.outputTokens;
      const cost = costOf(out.model, out.usage);
      if (cost !== null) costUsd = (costUsd ?? 0) + cost;
      const at = ctx.now();
      const common = {
        relatedFiles: sub.files.slice(0, MAX_RELATED_FILES),
        keyFiles: out.keyFiles,
        dependencies: sub.dependencies,
        risks: out.risks,
        conventions: out.conventions,
        pastFindings: out.pastFindings,
        facts: factsOf(sub),
        sourceFingerprint: sub.fingerprint,
        lastCommitSha: sha,
        lastUpdatedAt: at,
        stale: false,
        lastError: null,
      };
      // An edited entry keeps the person's text; the regenerated description waits as a proposal.
      const text =
        entry.source === "edited" ? { proposedDescription: out.description, proposedAt: at } : { description: out.description, proposedDescription: null, proposedAt: null };
      await db
        .update(knowledgeEntries)
        .set({ ...common, ...text })
        .where(scoped(knowledgeEntries, scope.orgId, eq(knowledgeEntries.repoId, scope.repoId), eq(knowledgeEntries.id, entry.id)));
      generated++;
    } catch (err) {
      failed++;
      const message = errorMessage(err);
      const usage = (err as { usage?: { inputTokens: number; outputTokens: number } }).usage;
      if (usage) {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
      }
      logger.warn("knowledge entry generation failed", { slug: entry.slug, error: message });
      await db
        .update(knowledgeEntries)
        .set({ lastError: message.slice(0, 1000) })
        .where(scoped(knowledgeEntries, scope.orgId, eq(knowledgeEntries.repoId, scope.repoId), eq(knowledgeEntries.id, entry.id)));
    }
  }

  if (calls > 0 || inputTokens > 0 || outputTokens > 0) {
    await db.insert(usageEvents).values({ orgId: scope.orgId, repoId: scope.repoId, kind: "knowledge", inputTokens, outputTokens, costUsd });
  }
  const remaining = regenerable.length - generated;
  const done = await finishRun(
    db,
    run,
    { status: "completed", discovered: subsystems.length, markedStale, generated, failed, remaining, inputTokens, outputTokens, costUsd, sha },
    ctx.now(),
  );
  logger.info("knowledge refresh completed", { discovered: subsystems.length, markedStale, generated, failed, remaining, inputTokens, outputTokens });

  // Stale entries beyond the cap: a follow-up run picks them up (only when this run made progress).
  if (remaining > 0 && generated > 0 && deps.queue) {
    try {
      await queueKnowledgeRefresh(db, deps.queue, { orgId: scope.orgId, repoId: scope.repoId, trigger: "continue", delayMs: CONTINUE_DELAY_MS });
    } catch (err) {
      logger.warn("could not queue the follow-up knowledge refresh", { error: errorMessage(err) });
    }
  }
  return resultOf(done);
}

function factsOf(sub: Subsystem) {
  return { routes: sub.routes, tables: sub.tables, tests: sub.tests, ciJobs: sub.ciJobs, fileCount: sub.files.length };
}
