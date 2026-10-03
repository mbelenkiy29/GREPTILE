/**
 * Fully local reviews (R3.5): index the working tree into the repository's PGlite database (incrementally, by
 * content hash), then run the review engine in-process with the model configured in the environment. Settings and
 * rules come from the base commit's `openreview.json`, as on the server.
 */
import { eq } from "drizzle-orm";
import { CONFIG_FILE, parseRepoConfig, resolveConfig } from "@/lib/config/repo-config";
import { repos } from "@/lib/db/schema";
import { runReview } from "@/lib/engine";
import type { EngineDeps, ReviewOutput, ReviewRequest } from "@/lib/engine/types";
import { DEFAULT_MAX_FILE_BYTES } from "@/lib/indexer/filetypes";
import { indexTree } from "@/lib/indexer";
import { listTree } from "@/lib/indexer/git";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm/types";
import { log } from "@/lib/log";
import { engineSettingsOf, ReviewModelError, toLocalResult, type LocalReviewResult } from "@/lib/review/local";
import { CliError, scrubSecrets } from "../errors";
import type { ReviewFocus, ReviewMode } from "@/lib/engine/types";
import { readBlob, showFile, worktreeEntries, worktreeFile, type BaseResolution, type ChangeSet } from "../git";
import type { CliIo } from "../io";
import { ensureLocalRepo, LOCAL_ORG_ID, openLocalDb } from "./db";
import { localEmbedder, localGateway, MODEL_FAILURE_HINT } from "./model";

export interface LocalReviewInput {
  root: string;
  /** `owner/name` (from the remote) or the directory name. */
  repoName: string;
  base: BaseResolution;
  headSha: string;
  change: ChangeSet;
  mode?: ReviewMode;
  focus?: ReviewFocus;
  progress(message: string): void;
  warn(message: string): void;
  /** The engine (tests may inject one); defaults to `runReview`. */
  runReview?: (deps: EngineDeps, req: ReviewRequest) => Promise<ReviewOutput>;
}

export async function runLocalReview(io: CliIo, input: LocalReviewInput): Promise<LocalReviewResult> {
  const { root } = input;
  // Fail fast on a missing model, before creating or indexing anything.
  if (!io.local?.llm) localGateway(io.env);
  const local = await openLocalDb(root);
  try {
    const { db } = local;
    const llm: LlmProvider = io.local?.llm ?? localGateway(io.env, db);
    const embedder: EmbeddingProvider | undefined = io.local?.embedder === null ? undefined : (io.local?.embedder ?? localEmbedder(io.env, db));
    if (!embedder) input.progress("Semantic search is off (set EMBEDDING_API_KEY to enable it); using the code graph and full-text search.");

    const repo = await ensureLocalRepo(db, input.repoName, input.base.ref.replace(/^origin\//, ""));
    input.progress(repo.indexedSha ? "Updating the local index…" : "Indexing the repository (first run; later runs are incremental)…");
    const started = Date.now();
    // The index matches the code under review: the working tree with --include-uncommitted, else the HEAD commit.
    // Both are keyed by git blob ids, so switching between them only re-indexes the files that differ.
    const entries = input.change.worktree ? await worktreeEntries(root) : await listTree(root);
    const blobs = new Map(entries.map((e) => [e.path, e.blob]));
    const tree = await indexTree(
      { db, ...(embedder ? { embedder } : {}), maxFileBytes: DEFAULT_MAX_FILE_BYTES, log: log.child({ component: "cli-index" }) },
      {
        scope: { orgId: LOCAL_ORG_ID, repoId: repo.id },
        repoName: input.repoName.split("/").pop() ?? input.repoName,
        dir: root,
        entries,
        ...(input.change.worktree ? {} : { read: (p: string) => readBlob(root, blobs.get(p)!) }),
        kind: repo.indexedSha ? "incremental" : "full",
      },
    );
    await db
      .update(repos)
      .set({
        indexStatus: "ready",
        indexError: null,
        indexedSha: input.headSha,
        indexedAt: new Date(),
        fileCount: tree.fileCount,
        symbolCount: tree.progress.symbols,
        languages: tree.languages,
      })
      .where(eq(repos.id, repo.id));
    input.progress(`Indexed ${tree.fileCount} files (${tree.changed.length} updated, ${tree.removed.length} removed) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

    // openreview.json from the base commit, so a change cannot weaken its own review.
    const configText = await showFile(root, input.base.sha, CONFIG_FILE);
    const parsed = configText === null ? {} : parseRepoConfig(configText);
    if (parsed.error) input.warn(`${parsed.error}. Using default settings.`);
    const config = resolveConfig(undefined, parsed.config, [], null);
    const mode = input.mode ?? config.settings.mode;

    const request: ReviewRequest = {
      orgId: LOCAL_ORG_ID,
      repo: { id: repo.id, fullName: input.repoName, defaultBranch: repo.defaultBranch },
      baseSha: input.base.sha,
      headSha: input.headSha,
      files: input.change.files.map((f) => ({ path: f.path, status: f.status, ...(f.previousPath ? { previousPath: f.previousPath } : {}), ...(f.patch !== undefined ? { patch: f.patch } : {}) })),
      readFile: (p, ref) => (ref === "base" ? showFile(root, input.base.sha, p) : input.change.worktree ? worktreeFile(root, p) : showFile(root, "HEAD", p)),
      mode,
      ...(input.focus ? { focus: input.focus } : {}),
      settings: engineSettingsOf(config.settings),
      rules: config.rules,
      learned: [],
      contextDocs: [],
      existingComments: [],
      priorFindings: [],
      historicalFindings: [],
    };
    input.progress(`Reviewing ${request.files.length} changed file${request.files.length === 1 ? "" : "s"} (${mode} mode)…`);
    const engine = input.runReview ?? runReview;
    const output = await engine({ db, llm, ...(embedder ? { embedder } : {}), log: log.child({ component: "cli-review" }) }, request);
    try {
      return toLocalResult(output, { repository: { id: null, fullName: input.repoName }, baseSha: input.base.sha, headSha: input.headSha, credits: 0 });
    } catch (err) {
      if (err instanceof ReviewModelError) throw new CliError(`The review model failed: ${scrubSecrets(err.message)}`, MODEL_FAILURE_HINT);
      throw err;
    }
  } finally {
    await local.close();
  }
}
