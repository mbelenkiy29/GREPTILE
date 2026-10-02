import { readFile } from "node:fs/promises";
import path from "node:path";
import { count, eq, inArray, sql } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { EMPTY_INDEX_PROGRESS, edges, files, installations, repoCommits, repos, symbols, type IndexProgress } from "@/lib/db/schema";
import { indexerEnv } from "@/lib/env";
import type { GitHost } from "@/lib/git/types";
import type { EmbeddingProvider } from "@/lib/llm";
import { errorMessage, log } from "@/lib/log";
import { applyRedactions, redactSecrets, scanForSecrets } from "@/lib/security/secret-scan";
import { analyzeFile } from "./analyze";
import { detectFileType, looksBinary, skipReasonForPath, type FileType, type SkipReason } from "./filetypes";
import { checkoutCommit, fetchRef, hasCommit, isAncestor, listTree, readCommits } from "./git";
import { resolveGraph } from "./graph";
import {
  createIndexJob,
  failInterruptedJobs,
  findIndexJobByQueueId,
  finishJob,
  getIndexJob,
  markJobRunning,
  markJobWaitingForLock,
  writeJobProgress,
  type IndexKind,
  type IndexTrigger,
} from "./jobs";
import { IndexLockedError, withRepoIndexLock, type LockOptions } from "./lock";
import { chunked } from "./sql";
import { embedPending, writeFile } from "./store";

export { WAITING_FOR_LOCK, cancelIndexJob, createIndexJob, getIndexStatus, listIndexJobs, type IndexJob, type IndexStatus, type IndexTrigger } from "./jobs";
export { IndexLockedError } from "./lock";

export interface IndexDeps {
  db: Db;
  host: GitHost;
  embedder: EmbeddingProvider;
  cacheDir: string;
  /** Files larger than this are skipped (default `INDEX_MAX_FILE_BYTES`). */
  maxFileBytes?: number;
  lock?: LockOptions;
}

export interface IndexRequest {
  orgId: string;
  repoId: number;
  /** Commit to index (a push's head); defaults to the default branch. */
  afterSha?: string;
  /** `full` re-parses every file; `incremental` only files whose content changed. A first index is always full. */
  mode?: IndexKind;
  trigger?: IndexTrigger;
  /** Existing `index_jobs` row (from `createIndexJob`); one is created when absent. */
  indexJobId?: number;
  /** Queue job id, so queue retries of one job update one row. */
  queueJobId?: string;
}

export interface IndexResult {
  indexJobId: number;
  kind: IndexKind;
  /** `skipped`: `afterSha` is already indexed or is older than the indexed commit (an out-of-order push). */
  status: "completed" | "cancelled" | "skipped";
  sha: string;
  filesParsed: number;
  filesRemoved: number;
  filesUnchanged: number;
  filesSkipped: Partial<Record<SkipReason, number>>;
  symbols: number;
  edges: number;
}

/**
 * Bumped when extraction changes, so the next incremental run re-analyzes files indexed by an older version (their
 * stored hash no longer matches).
 */
export const INDEX_FORMAT_VERSION = "v2";

/** The job was cancelled from the dashboard or API while it ran. */
class IndexCancelledError extends Error {
  constructor() {
    super("index job cancelled");
    this.name = "IndexCancelledError";
  }
}

interface Candidate {
  path: string;
  contentHash: string;
  sizeBytes: number;
  type: FileType;
}

/**
 * Repository indexer (R1.3, R6.3, R6.4). Checks out the default branch (or `afterSha`) and, under a per-repository
 * advisory lock, scans tracked files (skipping vendored, generated, binary, oversized, and secret files), re-analyzes
 * only files whose content changed (or all of them for a full run) one at a time — symbols, graph edges, chunks,
 * dependencies, with secrets redacted first — embeds new symbols and doc chunks, resolves the graph, and records
 * recent commits. Progress, attempts, failures, and changed files are tracked on an `index_jobs` row.
 */
export async function indexRepo(deps: IndexDeps, request: IndexRequest): Promise<IndexResult> {
  const { db } = deps;
  const [row] = await db
    .select({ repo: repos, installation: installations })
    .from(repos)
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(scoped(repos, request.orgId, eq(repos.id, request.repoId)));
  if (!row) throw new Error(`repo ${request.repoId} not found for org ${request.orgId}`);
  const { repo } = row;
  const kind: IndexKind = repo.indexedSha ? (request.mode ?? "incremental") : "full";
  const trigger: IndexTrigger = request.trigger ?? (request.afterSha ? "push" : repo.indexedSha ? "manual" : "install");

  let job = request.indexJobId
    ? await getIndexJob(db, repo.orgId, repo.id, request.indexJobId)
    : request.queueJobId
      ? await findIndexJobByQueueId(db, repo.orgId, repo.id, request.queueJobId)
      : null;
  if (request.indexJobId && !job) throw new Error(`index job ${request.indexJobId} not found for repo ${repo.id}`);
  const logger = log.child({ orgId: repo.orgId, repoId: repo.id, job: "index-repo" });
  if (job?.status === "cancelled") {
    logger.info("index job was cancelled before it started", { indexJobId: job.id });
    return emptyResult(job.id, kind, "cancelled", repo.indexedSha ?? "");
  }
  if (!job || job.status === "completed") {
    job = await createIndexJob(db, { orgId: repo.orgId, repoId: repo.id, kind, trigger, toSha: request.afterSha ?? null, queueJobId: request.queueJobId ?? null });
  }
  const jobId = job.id;
  const jlog = logger.child({ indexJobId: jobId });
  const scope = { orgId: repo.orgId, repoId: repo.id };

  try {
    return await withRepoIndexLock(db, repo.id, () => run(deps, { repo, externalInstallationId: row.installation.externalId, jobId, kind, afterSha: request.afterSha, log: jlog }), deps.lock);
  } catch (err) {
    if (err instanceof IndexCancelledError) {
      jlog.info("index job cancelled");
      await db
        .update(repos)
        .set({ indexStatus: repo.indexedSha ? "ready" : "pending" })
        .where(scoped(repos, repo.orgId, eq(repos.id, repo.id)));
      return emptyResult(jobId, kind, "cancelled", repo.indexedSha ?? "");
    }
    const message = errorMessage(err);
    if (err instanceof IndexLockedError) {
      // Back in the queue (still cancellable). A row another delivery of this job is running stays untouched.
      await markJobWaitingForLock(db, scope, jobId);
      jlog.warn("index lock busy; the job will run again later", { error: message, retryAfterMs: err.retryAfterMs });
    } else {
      await finishJob(db, scope, jobId, { status: "failed", error: message });
      jlog.error("index failed", { error: message });
      await db.update(repos).set({ indexStatus: "failed", indexError: message }).where(scoped(repos, repo.orgId, eq(repos.id, repo.id)));
    }
    throw err;
  }
}

function emptyResult(indexJobId: number, kind: IndexKind, status: IndexResult["status"], sha: string): IndexResult {
  return { indexJobId, kind, status, sha, filesParsed: 0, filesRemoved: 0, filesUnchanged: 0, filesSkipped: {}, symbols: 0, edges: 0 };
}

async function run(
  deps: IndexDeps,
  ctx: {
    repo: typeof repos.$inferSelect;
    externalInstallationId: number;
    jobId: number;
    kind: IndexKind;
    afterSha?: string;
    log: ReturnType<typeof log.child>;
  },
): Promise<IndexResult> {
  const { db } = deps;
  const { jobId } = ctx;
  const scope = { orgId: ctx.repo.orgId, repoId: ctx.repo.id };
  const started = Date.now();

  // Re-read the repository under the lock: a run that held it may have advanced indexedSha meanwhile.
  const [fresh] = await db.select().from(repos).where(scoped(repos, scope.orgId, eq(repos.id, scope.repoId)));
  if (!fresh) throw new Error(`repo ${scope.repoId} not found for org ${scope.orgId}`);
  const repo = fresh;
  const kind: IndexKind = repo.indexedSha ? ctx.kind : "full";

  // With the lock held no other run is active: a job still marked running was left by a worker that stopped.
  const interrupted = await failInterruptedJobs(db, scope, jobId);
  if (interrupted) ctx.log.warn("marked interrupted index jobs as failed", { count: interrupted });

  // A previous run that did not complete may have written files without resolving the graph; repair it fully.
  const previous = repo.lastIndexJobId ? await getIndexJob(db, repo.orgId, repo.id, repo.lastIndexJobId) : null;
  const recovering = kind === "incremental" && previous !== null && previous.status !== "completed";
  if (!(await markJobRunning(db, scope, jobId, { kind, fromSha: repo.indexedSha }))) throw new IndexCancelledError();
  await db.update(repos).set({ indexStatus: "indexing", indexError: null, lastIndexJobId: jobId }).where(scoped(repos, repo.orgId, eq(repos.id, repo.id)));
  ctx.log.info("index started", { kind, fromSha: repo.indexedSha, recovering });

  const progress: IndexProgress = { ...EMPTY_INDEX_PROGRESS, filesSkipped: {}, phase: "checkout" };
  const checkpoint = async (phase?: IndexProgress["phase"], extra: { toSha?: string } = {}) => {
    if (phase) progress.phase = phase;
    if (!(await writeJobProgress(db, scope, jobId, progress, extra))) throw new IndexCancelledError();
  };
  const skip = (reason: SkipReason) => {
    progress.filesSkipped[reason] = (progress.filesSkipped[reason] ?? 0) + 1;
  };

  // checkout
  const dir = path.join(deps.cacheDir, String(repo.id));
  const client = deps.host.client(ctx.externalInstallationId);
  const url = await client.cloneUrl(repo.fullName);
  const fetched = await fetchRef(url, dir, ctx.afterSha ?? repo.defaultBranch);
  if (ctx.afterSha && repo.indexedSha && (await alreadyIndexed(url, dir, fetched, repo.indexedSha))) {
    // A push delivered (or retried) after a newer one was indexed: indexing it would roll the index back.
    ctx.log.info("commit already indexed or older than the indexed commit; skipping", { sha: fetched, indexedSha: repo.indexedSha });
    progress.phase = "done";
    await db
      .update(repos)
      .set({ indexStatus: "ready", indexError: null, lastIndexJobId: previous?.id ?? null })
      .where(scoped(repos, repo.orgId, eq(repos.id, repo.id)));
    await finishJob(db, scope, jobId, { status: "completed", progress, changedFiles: [], toSha: repo.indexedSha });
    return emptyResult(jobId, kind, "skipped", repo.indexedSha);
  }
  const sha = await checkoutCommit(dir, fetched);
  await checkpoint("scan", { toSha: sha });

  // scan: decide from paths, sizes, and blob ids alone which files need (re)analysis
  const maxBytes = deps.maxFileBytes ?? indexerEnv().INDEX_MAX_FILE_BYTES;
  const candidates: Candidate[] = [];
  for (const entry of await listTree(dir)) {
    const reason = entry.regular ? skipReasonForPath(entry.path, entry.sizeBytes, maxBytes) : "unsupported";
    if (reason) skip(reason);
    else candidates.push({ path: entry.path, contentHash: `${INDEX_FORMAT_VERSION}:${entry.blob}`, sizeBytes: entry.sizeBytes, type: detectFileType(entry.path)! });
  }
  const existing = await db
    .select({ id: files.id, path: files.path, contentHash: files.contentHash })
    .from(files)
    .where(scoped(files, repo.orgId, eq(files.repoId, repo.id)));
  const existingByPath = new Map(existing.map((f) => [f.path, f]));
  const current = new Set(candidates.map((c) => c.path));
  const changed = kind === "full" ? candidates : candidates.filter((c) => existingByPath.get(c.path)?.contentHash !== c.contentHash);
  const removed = existing.filter((f) => !current.has(f.path));
  progress.filesTotal = candidates.length;
  progress.filesChanged = changed.length;
  progress.filesRemoved = removed.length;

  // Names of symbols about to disappear: edges into them must be re-resolved.
  const affectedNames = new Set<string>();
  const replacedIds = [...removed.map((f) => f.id), ...changed.flatMap((c) => existingByPath.get(c.path)?.id ?? [])];
  for (const ids of chunked(replacedIds, 1000)) {
    const rows = await db
      .selectDistinct({ name: symbols.name })
      .from(symbols)
      .where(scoped(symbols, repo.orgId, eq(symbols.repoId, repo.id), inArray(symbols.fileId, ids)));
    for (const r of rows) affectedNames.add(r.name);
  }
  const [maxEdge] = await db
    .select({ id: sql<number>`coalesce(max(${edges.id}), 0)` })
    .from(edges)
    .where(scoped(edges, repo.orgId, eq(edges.repoId, repo.id)));
  const newEdgesAfterId = Number(maxEdge?.id ?? 0);
  for (const ids of chunked(removed.map((f) => f.id), 500)) {
    await db.delete(files).where(scoped(files, repo.orgId, eq(files.repoId, repo.id), inArray(files.id, ids)));
  }
  await checkpoint("parse");

  // parse: one file at a time (never every file's content in memory)
  const repoName = repo.fullName.split("/").pop() ?? repo.fullName;
  let parsed = 0;
  let binaryRemoved = 0;
  for (const [i, c] of changed.entries()) {
    const existingId = existingByPath.get(c.path)?.id ?? null;
    const buf = await readFile(path.join(dir, c.path));
    if (looksBinary(buf.subarray(0, 8192))) {
      skip("binary");
      progress.filesTotal--;
      if (existingId !== null) {
        await db.delete(files).where(scoped(files, repo.orgId, eq(files.repoId, repo.id), eq(files.id, existingId)));
        binaryRemoved++;
      }
    } else {
      const raw = buf.toString("utf8").replace(/\u0000/g, "");
      const findings = scanForSecrets(raw);
      progress.secretLinesRedacted += findings.length;
      const analysis = await analyzeFile(c.path, applyRedactions(raw, findings), c.type, { repoName });
      if (analysis.extractionError) ctx.log.warn("entity extraction failed; file indexed for search only", { path: c.path, error: analysis.extractionError });
      await writeFile(db, scope, { path: c.path, contentHash: c.contentHash, sizeBytes: c.sizeBytes, existingId }, analysis);
      for (const s of analysis.symbols) affectedNames.add(s.name);
      parsed++;
    }
    progress.filesDone = i + 1;
    if ((i + 1) % 100 === 0) await checkpoint();
  }
  progress.filesRemoved += binaryRemoved;
  await checkpoint("embed");

  progress.embedded = 0;
  await embedPending(db, deps.embedder, scope, async (n) => {
    progress.embedded = n;
    await checkpoint();
  });
  await checkpoint("graph");

  const anyChange = changed.length > 0 || removed.length > 0 || recovering;
  await resolveGraph(db, scope, {
    newEdgesAfterId: recovering ? 0 : newEdgesAfterId,
    affectedNames: kind === "full" || recovering ? null : [...affectedNames],
    changed: anyChange,
    addedPaths: changed.filter((c) => !existingByPath.has(c.path)).map((c) => c.path),
  });
  await checkpoint("finalize");

  // Oldest first, so row ids grow with recency (a stable tie-break for commits made in the same second).
  const commits = (await readCommits(dir)).reverse();
  for (const batch of chunked(commits, 100)) {
    await db
      .insert(repoCommits)
      .values(
        batch.map((c) => ({
          orgId: repo.orgId,
          repoId: repo.id,
          sha: c.sha,
          parentSha: c.parentSha,
          message: redactSecrets(c.message).slice(0, 500),
          author: c.author.slice(0, 200),
          committedAt: c.committedAt,
          changedPaths: c.changedPaths.slice(0, 200),
        })),
      )
      .onConflictDoNothing({ target: [repoCommits.repoId, repoCommits.sha] });
  }

  const [[fileCount], [symbolCount], [edgeCount], languageRows] = await Promise.all([
    db.select({ n: count() }).from(files).where(scoped(files, repo.orgId, eq(files.repoId, repo.id))),
    db.select({ n: count() }).from(symbols).where(scoped(symbols, repo.orgId, eq(symbols.repoId, repo.id))),
    db.select({ n: count() }).from(edges).where(scoped(edges, repo.orgId, eq(edges.repoId, repo.id))),
    db
      .select({ language: files.language, n: count() })
      .from(files)
      .where(scoped(files, repo.orgId, eq(files.repoId, repo.id), sql`${files.tags} && array['source', 'test']::text[]`))
      .groupBy(files.language),
  ]);
  progress.symbols = symbolCount?.n ?? 0;
  progress.edges = edgeCount?.n ?? 0;
  progress.phase = "done";
  const languages = Object.fromEntries(languageRows.sort((a, b) => b.n - a.n).map((r) => [r.language, r.n]));

  await db
    .update(repos)
    .set({
      indexStatus: "ready",
      indexError: null,
      indexedSha: sha,
      indexedAt: new Date(),
      fileCount: fileCount?.n ?? 0,
      symbolCount: progress.symbols,
      languages,
      lastIndexJobId: jobId,
    })
    .where(scoped(repos, repo.orgId, eq(repos.id, repo.id)));
  const changedFiles = [...changed.map((c) => c.path), ...removed.map((f) => f.path)].sort();
  await finishJob(db, scope, jobId, { status: "completed", progress, changedFiles, toSha: sha });
  ctx.log.info("index completed", {
    kind,
    sha,
    filesChanged: changed.length,
    filesRemoved: progress.filesRemoved,
    symbols: progress.symbols,
    edges: progress.edges,
    ms: Date.now() - started,
  });

  return {
    indexJobId: jobId,
    kind,
    status: "completed",
    sha,
    filesParsed: parsed,
    filesRemoved: progress.filesRemoved,
    filesUnchanged: candidates.length - changed.length,
    filesSkipped: { ...progress.filesSkipped },
    symbols: progress.symbols,
    edges: progress.edges,
  };
}

/**
 * Whether `sha` is the indexed commit or one of its ancestors. The indexed commit is fetched when the cache lacks it
 * (e.g. a fresh cache directory); when it cannot be found, `sha` is treated as new.
 */
async function alreadyIndexed(url: string, dir: string, sha: string, indexedSha: string): Promise<boolean> {
  if (sha === indexedSha) return true;
  if (!(await hasCommit(dir, indexedSha))) await fetchRef(url, dir, indexedSha).catch(() => undefined);
  return isAncestor(dir, sha, indexedSha);
}
