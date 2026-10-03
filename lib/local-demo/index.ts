/**
 * The `pnpm demo` walkthrough (R6.22 demo / local mode): with DEMO_MODE on (never in production unless explicitly
 * allowed), it creates (or reuses) a demo org, a local installation, and the fixture repository
 * `fixtures/demo-repo` as a bare repository on the local git host; indexes it with the real indexer; pushes a branch
 * whose change breaks a caller in another file; opens a local pull request; and runs the real pipeline
 * (`requestReview` → `runReviewJob`: retrieval, agents, verifier, publishing) against it. The review then shows on
 * the dashboard like any other, with the local pull request page rendering the diff and inline comments.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { upsertDevUser } from "@/lib/auth/users";
import { completeInstallation } from "@/lib/data/installations";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { memberships, repos } from "@/lib/db/schema";
import type { LocalModeEnv } from "@/lib/env";
import { LocalGitHost } from "@/lib/git/local/host";
import { fileUrl, initBareRepo, repoExists, resolveCommit } from "@/lib/git/local/repo";
import { ensureLocalInstallation, openLocalPullRequest } from "@/lib/git/local/store";
import { indexRepo } from "@/lib/indexer";
import { MemoryQueue } from "@/lib/jobs/types";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm/types";
import { log as rootLog, type Logger } from "@/lib/log";
import { requestReview } from "@/lib/pipeline/request";
import { runReviewJob, type ReviewJobResult } from "@/lib/review/run";

const exec = promisify(execFile);

export const LOCAL_DEMO_ORG_ID = "org_local_demo";
export const LOCAL_DEMO_ORG_NAME = "Local demo";
/** The fixture repository and its scenario (`base/`, `pr/`, `fix/`, `scenario.json`, `recorded/`). */
export const DEMO_FIXTURE_DIR = path.resolve(import.meta.dirname, "../../fixtures/demo-repo");

export const scenarioSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/),
  defaultBranch: z.string().min(1),
  baseCommitMessage: z.string().min(1),
  pullRequest: z.object({
    branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    title: z.string().min(1),
    body: z.string(),
    author: z.string().min(1),
    commitMessage: z.string().min(1),
    changes: z.string().min(1),
  }),
  fix: z.object({ commitMessage: z.string().min(1), changes: z.string().min(1) }),
  bug: z.object({
    path: z.string(),
    line: z.number().int(),
    caller: z.object({ path: z.string(), line: z.number().int() }),
    summary: z.string(),
  }),
});
export type DemoScenario = z.infer<typeof scenarioSchema>;

export async function loadScenario(fixtureDir = DEMO_FIXTURE_DIR): Promise<DemoScenario> {
  return scenarioSchema.parse(JSON.parse(await readFile(path.join(fixtureDir, "scenario.json"), "utf8")));
}

export interface LocalDemoDeps {
  db: Db;
  /** Demo mode settings (DEMO_MODE, NODE_ENV, LOCAL_GIT_ROOT); the local host refuses to run without demo mode. */
  mode: Pick<LocalModeEnv, "NODE_ENV" | "DEMO_MODE" | "DEMO_MODE_ALLOW_PRODUCTION" | "LOCAL_GIT_ROOT">;
  llm: LlmProvider;
  embedder: EmbeddingProvider;
  /** Indexer checkout cache (REPO_CACHE_DIR). */
  cacheDir: string;
  /** Base URL of the dashboard, for the printed links. */
  appUrl: string;
  fixtureDir?: string;
  log?: Logger;
  progress?: (message: string) => void;
  now?: () => Date;
}

export interface LocalDemoResult {
  orgId: string;
  repoId: number;
  repository: string;
  prNumber: number;
  localPullRequestId: number;
  branch: string;
  run: ReviewJobResult;
  /** The review's dashboard page. */
  reviewUrl: string;
  /** The local pull request page (diff with inline comments). */
  pullRequestUrl: string;
  /** Whether the bare repository already existed (a re-run reuses it and opens a new pull request). */
  reusedRepository: boolean;
}

/** Runs git in a work tree with a fixed identity (the demo's commits must not depend on the developer's config). */
async function git(cwd: string, args: string[], author = "OpenReview demo") {
  const { stdout } = await exec("git", ["-c", `user.name=${author}`, "-c", `user.email=${author.replace(/\W+/g, ".").toLowerCase()}@demo.invalid`, "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Copies a scenario directory's files over a work tree and commits them; returns the new commit. */
async function commitChanges(work: string, from: string, message: string, author: string): Promise<string> {
  await cp(from, work, { recursive: true, force: true });
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "--quiet", "--no-verify", "-m", message], author);
  return git(work, ["rev-parse", "HEAD"]);
}

/** Gives the dev-login user (AUTH_DEV_LOGIN) an owner seat in the demo org so the dashboard shows it. */
async function addDevUser(db: Db, orgId: string, now: Date) {
  const user = await upsertDevUser(db, now);
  await db.insert(memberships).values({ orgId, userId: user.id, role: "owner" }).onConflictDoNothing();
}

/** An unused branch name: the scenario's, or with a numeric suffix on re-runs. */
async function freeBranch(bare: string, wanted: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? wanted : `${wanted}-${n}`;
    if (!(await resolveCommit(bare, `refs/heads/${name}`))) return name;
  }
  throw new Error(`no free branch name for ${wanted}`);
}

export async function runLocalDemo(deps: LocalDemoDeps): Promise<LocalDemoResult> {
  const { db } = deps;
  const log = (deps.log ?? rootLog).child({ component: "local-demo" });
  const say = deps.progress ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const fixtureDir = deps.fixtureDir ?? DEMO_FIXTURE_DIR;
  const scenario = await loadScenario(fixtureDir);
  const root = deps.mode.LOCAL_GIT_ROOT;
  // Refuses unless demo mode is on (and not in production, unless explicitly allowed).
  const host = new LocalGitHost({ db, root, mode: deps.mode });
  const orgId = LOCAL_DEMO_ORG_ID;
  const fullName = scenario.repository;
  const owner = fullName.split("/")[0]!;

  // 1. Org, local installation, and the dev-login user's seat.
  const installation = await ensureLocalInstallation(db, { orgId, owner, orgName: LOCAL_DEMO_ORG_NAME });
  await addDevUser(db, orgId, now());

  // 2. The bare repository with the fixture on its default branch (reused when it exists).
  const reusedRepository = await repoExists(root, fullName);
  const bare = await initBareRepo(root, fullName, scenario.defaultBranch);
  const work = await mkdtemp(path.join(tmpdir(), "openreview-demo-"));
  try {
    if (!(await resolveCommit(bare, `refs/heads/${scenario.defaultBranch}`))) {
      say(`Creating ${fullName} from fixtures/demo-repo…`);
      await git(work, ["init", "--quiet", `--initial-branch=${scenario.defaultBranch}`]);
      await commitChanges(work, path.join(fixtureDir, "base"), scenario.baseCommitMessage, "OpenReview demo");
      await git(work, ["push", "--quiet", fileUrl(bare), `${scenario.defaultBranch}:refs/heads/${scenario.defaultBranch}`]);
    } else {
      say(`Reusing ${fullName} in ${root}.`);
      await git(work, ["clone", "--quiet", "--branch", scenario.defaultBranch, fileUrl(bare), "."]);
    }
    const { repos: connected } = await completeInstallation(db, host, { orgId, orgName: LOCAL_DEMO_ORG_NAME, installationId: installation.externalId });
    const repo = connected.find((r) => r.fullName === fullName);
    if (!repo) throw new Error(`${fullName} was not found on the local host`);
    await db.update(repos).set({ enabled: true }).where(scoped(repos, orgId, eq(repos.id, repo.id)));

    // 3. Index the default branch with the real indexer (incrementally after the first run).
    const tip = (await resolveCommit(bare, `refs/heads/${scenario.defaultBranch}`))!;
    if (repo.indexedSha !== tip) {
      say("Indexing the repository (symbols, call graph, chunks, embeddings)…");
      const indexed = await indexRepo({ db, host, embedder: deps.embedder, cacheDir: deps.cacheDir }, { orgId, repoId: repo.id, mode: repo.indexedSha ? "incremental" : "full", trigger: "manual" });
      say(`Indexed ${indexed.filesParsed} files (${indexed.symbols} symbols, ${indexed.edges} graph edges).`);
    }

    // 4. A branch whose change breaks a caller in another file, and a pull request for it.
    if (reusedRepository) await git(work, ["checkout", "--quiet", scenario.defaultBranch]);
    const branch = await freeBranch(bare, scenario.pullRequest.branch);
    await git(work, ["checkout", "--quiet", "-b", branch]);
    await commitChanges(work, path.join(fixtureDir, scenario.pullRequest.changes), scenario.pullRequest.commitMessage, scenario.pullRequest.author);
    await git(work, ["push", "--quiet", fileUrl(bare), `${branch}:refs/heads/${branch}`]);
    const pr = await openLocalPullRequest(db, root, {
      orgId,
      repoId: repo.id,
      fullName,
      title: scenario.pullRequest.title,
      body: scenario.pullRequest.body,
      author: scenario.pullRequest.author,
      baseRef: scenario.defaultBranch,
      headRef: branch,
    });
    say(`Opened local pull request ${fullName}#${pr.number} (${branch} → ${scenario.defaultBranch}).`);

    // 5. The real pipeline: a tracked run, then the review job (engine + publishing to the local host).
    const queue = new MemoryQueue();
    const requested = await requestReview({ db, queue, debounceMs: 0, log }, { orgId, repoId: repo.id, prNumber: pr.number, headSha: pr.headSha, trigger: "manual", requestedBy: "pnpm demo" });
    say("Reviewing (context retrieval, specialized agents, verification, summary)…");
    const run = await runReviewJob({ db, host, llm: deps.llm, embedder: deps.embedder, queue, log }, { runId: requested.runId, orgId, repoId: repo.id, prNumber: pr.number });
    const base = deps.appUrl.replace(/\/+$/, "");
    return {
      orgId,
      repoId: repo.id,
      repository: fullName,
      prNumber: pr.number,
      localPullRequestId: pr.id,
      branch,
      run,
      reviewUrl: `${base}/dashboard/reviews/${requested.reviewId}`,
      pullRequestUrl: `${base}/dashboard/local/pr/${pr.id}`,
      reusedRepository,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
