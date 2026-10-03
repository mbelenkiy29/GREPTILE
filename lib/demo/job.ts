/**
 * The `demo-review` job (R3.7): reviews a public GitHub pull request for the "Paste a PR" demo.
 *
 *   claim the row → kill switch and daily budget → GitHub API (public repo, size caps, PR size caps, changed files)
 *   → shallow fetch of the PR base and head (anonymous HTTPS) → index the base into `org_demo` (incremental when the
 *   repo was indexed before) → `runReview` in fast mode → store the result on the row
 *
 * Nothing is ever written to GitHub: the job has no git-host client, only the read-only public API and anonymous git
 * fetches. Failures are recorded on the row (the visitor sees a short reason) and never retried.
 */
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { SETTING_DEFAULTS } from "@/lib/config/settings";
import type { Db } from "@/lib/db";
import { demoReviews, repos, type DemoFinding, type DemoResultData } from "@/lib/db/schema";
import { runReview } from "@/lib/engine";
import type { ChangedFileInput, EngineDeps, ReviewOutput, ReviewRequest } from "@/lib/engine/types";
import type { DemoEnv } from "@/lib/env";
import { indexTree } from "@/lib/indexer";
import { checkoutCommit, fetchRef, listTree, readBlob } from "@/lib/indexer/git";
import { withRepoIndexLock } from "@/lib/indexer/lock";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { engineSettingsOf, modelFailureWarnings, ReviewModelError } from "@/lib/review/local";
import { checkDemoBudget } from "./limits";
import { DEMO_ORG_ID, demoRepo, ensureDemoOrg } from "./org";
import { PublicGitHub, PublicGitHubError, publicCloneUrl } from "./github";

const GIT_TIMEOUT_MS = 300_000;
const REVIEW_TIMEOUT_MS = 15 * 60_000;
const MAX_INDEX_FILE_BYTES = 512 * 1024;

export interface DemoJobDeps {
  db: Db;
  llm: LlmProvider;
  embedder?: EmbeddingProvider;
  env: DemoEnv;
  github: PublicGitHub;
  /** Where demo checkouts live (`<cacheDir>/demo/<repoId>`). */
  cacheDir: string;
  /** Clone URL of a public repository (tests use a local fixture). */
  cloneUrl?: (owner: string, repo: string) => string;
  /** The engine (tests may inject one). */
  runReview?: (deps: EngineDeps, req: ReviewRequest) => Promise<ReviewOutput>;
  log?: Logger;
  now?: () => Date;
}

export interface DemoJobResult {
  status: "completed" | "failed" | "rejected" | "skipped";
  reason?: string;
}

/** A refusal shown to the visitor (not a failure of the system). */
class Rejected extends Error {}

export function demoGitHub(env: Pick<DemoEnv, "DEMO_GITHUB_TOKEN">, fetchImpl?: typeof fetch): PublicGitHub {
  return new PublicGitHub({ ...(env.DEMO_GITHUB_TOKEN ? { token: env.DEMO_GITHUB_TOKEN } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

/** Head-commit lines around a finding (two lines of context, at most 40 lines). */
export function codeExcerpt(content: string | null, startLine: number, endLine: number): DemoFinding["code"] {
  if (content === null) return null;
  const lines = content.split("\n");
  const from = Math.max(1, startLine - 2);
  const to = Math.min(lines.length, Math.max(endLine, startLine) + 2, from + 39);
  if (from > lines.length) return null;
  return { startLine: from, text: lines.slice(from - 1, to).join("\n") };
}

export async function runDemoReviewJob(deps: DemoJobDeps, payload: { demoId: string }): Promise<DemoJobResult> {
  const { db, env } = deps;
  const clock = deps.now ?? (() => new Date());
  const log = (deps.log ?? rootLog).child({ component: "demo", demoId: payload.demoId });
  const where = and(eq(demoReviews.orgId, DEMO_ORG_ID), eq(demoReviews.id, payload.demoId));
  const [claimed] = await db
    .update(demoReviews)
    .set({ status: "running", startedAt: clock() })
    .where(and(where, eq(demoReviews.status, "queued")))
    .returning();
  if (!claimed) return { status: "skipped", reason: "not queued" };
  const finish = async (status: "completed" | "failed" | "rejected", values: Partial<typeof demoReviews.$inferInsert> = {}) => {
    await db
      .update(demoReviews)
      .set({ status, finishedAt: clock(), ...values })
      .where(where);
  };
  const { owner, repo: name, prNumber } = claimed;

  try {
    if (!env.DEMO_ENABLED) throw new Rejected("The public demo is turned off on this server.");
    const budget = await checkDemoBudget(db, env, clock());
    if (!budget.ok) throw new Rejected(budget.message);

    const gh = deps.github;
    const ghRepo = await gh.getRepo(owner, name).catch((err: unknown) => {
      if (err instanceof PublicGitHubError && err.status === 404) throw new Rejected("That repository does not exist or is not public.");
      throw err;
    });
    if (ghRepo.private) throw new Rejected("Only public repositories can be reviewed in the demo.");
    if (ghRepo.size > env.DEMO_MAX_REPO_MB * 1024) {
      throw new Rejected(`The repository is larger than the demo's ${env.DEMO_MAX_REPO_MB} MB limit. Install OpenReview to review it.`);
    }
    const pr = await gh.getPullRequest(owner, name, prNumber).catch((err: unknown) => {
      if (err instanceof PublicGitHubError && err.status === 404) throw new Rejected("That pull request does not exist.");
      throw err;
    });
    if (pr.base.repo && pr.base.repo.full_name.toLowerCase() !== ghRepo.full_name.toLowerCase()) throw new Rejected("That pull request does not belong to this repository.");
    if (pr.changed_files > env.DEMO_MAX_PR_FILES) throw new Rejected(`The pull request changes ${pr.changed_files} files; the demo reviews at most ${env.DEMO_MAX_PR_FILES}.`);
    if (pr.additions > env.DEMO_MAX_PR_ADDITIONS) throw new Rejected(`The pull request adds ${pr.additions} lines; the demo reviews at most ${env.DEMO_MAX_PR_ADDITIONS}.`);
    if (pr.changed_files === 0) throw new Rejected("The pull request has no changes to review.");
    await db
      .update(demoReviews)
      .set({ prTitle: pr.title.slice(0, 300), prAuthor: pr.user?.login ?? null, baseSha: pr.base.sha, headSha: pr.head.sha })
      .where(where);
    const prFiles = await gh.listPullRequestFiles(owner, name, prNumber, env.DEMO_MAX_PR_FILES);

    // Index the base into the demo org, under the repository's index lock (other demo reviews of it may run).
    const installationId = await ensureDemoOrg(db);
    const repoRow = await demoRepo(db, installationId, ghRepo);
    await db.update(demoReviews).set({ repoId: repoRow.id }).where(where);
    const dir = path.join(deps.cacheDir, "demo", String(repoRow.id));
    const url = (deps.cloneUrl ?? publicCloneUrl)(owner, name);
    const scope = { orgId: DEMO_ORG_ID, repoId: repoRow.id };
    await withRepoIndexLock(
      db,
      repoRow.id,
      async () => {
        const baseSha = await fetchRef(url, dir, pr.base.sha, { depth: 1, timeoutMs: GIT_TIMEOUT_MS });
        await checkoutCommit(dir, baseSha);
        const [fresh] = await db.select({ indexedSha: repos.indexedSha }).from(repos).where(and(eq(repos.orgId, DEMO_ORG_ID), eq(repos.id, repoRow.id)));
        if (fresh?.indexedSha !== baseSha) {
          const tree = await indexTree(
            { db, ...(deps.embedder ? { embedder: deps.embedder } : {}), maxFileBytes: MAX_INDEX_FILE_BYTES, log },
            { scope, repoName: name, dir, entries: await listTree(dir), kind: fresh?.indexedSha ? "incremental" : "full" },
          );
          await db
            .update(repos)
            .set({ indexStatus: "ready", indexError: null, indexedSha: baseSha, indexedAt: clock(), fileCount: tree.fileCount, symbolCount: tree.progress.symbols, languages: tree.languages })
            .where(and(eq(repos.orgId, DEMO_ORG_ID), eq(repos.id, repoRow.id)));
        }
        await fetchRef(url, dir, pr.head.sha, { depth: 1, timeoutMs: GIT_TIMEOUT_MS });
      },
      { attempts: 240, delayMs: 1000 },
    );

    const files: ChangedFileInput[] = prFiles.map((f) => ({
      path: f.filename,
      status: f.status,
      ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
      ...(f.patch !== undefined ? { patch: f.patch } : {}),
    }));
    const contents = new Map<string, Promise<string | null>>();
    const readFile: ReviewRequest["readFile"] = (p, which) => {
      const sha = which === "base" ? pr.base.sha : pr.head.sha;
      const key = `${sha}:${p}`;
      let hit = contents.get(key);
      if (!hit) {
        hit = readBlob(dir, sha, p).then((b) => (b ? b.toString("utf8") : null));
        contents.set(key, hit);
      }
      return hit;
    };
    const request: ReviewRequest = {
      orgId: DEMO_ORG_ID,
      repo: { id: repoRow.id, fullName: ghRepo.full_name, defaultBranch: ghRepo.default_branch },
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      pr: { number: pr.number, title: pr.title, body: pr.body ?? "", author: pr.user?.login ?? "", baseRef: pr.base.ref, headRef: pr.head.ref },
      files,
      readFile,
      mode: "fast",
      settings: engineSettingsOf(SETTING_DEFAULTS),
      rules: [],
      learned: [],
      contextDocs: [],
      existingComments: [],
      priorFindings: [],
      historicalFindings: [],
      signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
    };
    const engine = deps.runReview ?? runReview;
    const output = await engine({ db, llm: deps.llm, ...(deps.embedder ? { embedder: deps.embedder } : {}), log }, request);
    modelFailureWarnings(output);
    const findings: DemoFinding[] = [];
    for (const f of output.findings) {
      findings.push({
        title: f.title,
        description: f.description,
        impact: f.impact,
        severity: f.severity,
        confidence: f.confidence,
        category: f.category,
        path: f.path,
        startLine: f.startLine,
        endLine: f.endLine,
        suggestedFix: f.suggestedFix,
        code: codeExcerpt(await readFile(f.path, "head"), f.startLine, f.endLine),
      });
    }
    const result: DemoResultData = {
      summary: {
        overview: output.summary.overview,
        whatChanged: output.summary.whatChanged,
        riskLevel: output.summary.riskLevel,
        riskRationale: output.summary.riskRationale,
        confidence: output.summary.confidence,
      },
      findings,
      filesReviewed: output.metadata.filesReviewed,
      durationMs: output.metadata.durationMs,
    };
    await finish("completed", { result, costUsd: output.usage.costUsd, reason: null });
    log.info("demo review completed", { findings: findings.length, costUsd: output.usage.costUsd });
    return { status: "completed" };
  } catch (err) {
    if (err instanceof Rejected) {
      await finish("rejected", { reason: err.message });
      log.info("demo review rejected", { reason: err.message });
      return { status: "rejected", reason: err.message };
    }
    const reason =
      err instanceof PublicGitHubError && /rate limit/.test(err.message)
        ? "GitHub's API rate limit was reached. Try again in a while."
        : err instanceof ReviewModelError
          ? "The review model could not be reached. Try again later."
          : "The demo review failed. Try again later.";
    log.warn("demo review failed", { error: errorMessage(err) });
    await finish("failed", { reason });
    return { status: "failed", reason };
  }
}
