/**
 * `openreview review` (R3.5): reviews the current branch against its base — on the server when logged in and the
 * repository is connected, otherwise fully locally — and prints the result for a person, an agent, or a program.
 */
import path from "node:path";
import { z } from "zod";
import type { Severity } from "@/lib/engine/types";
import type { ReviewFocus, ReviewMode } from "@/lib/engine/types";
import { LOCAL_REVIEW_LIMITS, localReviewResultSchema, type LocalReviewBody, type LocalReviewResult } from "@/lib/review/local";
import { ApiClient, ApiResponseError } from "../api";
import { resolveAuth } from "../config";
import { findRepository, type Ctx } from "../context";
import { CliError, EXIT } from "../errors";
import { collectChanges, currentBranch, headSha, remoteRepo, repoRoot, resolveBase, showFile, worktreeFile, type ChangeSet } from "../git";
import { runLocalReview } from "../local/review";
import { agentHeader, failsOn, findingsForAgent, renderAgent, renderHuman, sortFindings, type CliReviewJson } from "../render";

export interface ReviewOptions {
  base?: string;
  includeUncommitted?: boolean;
  /** Force local mode. */
  local?: boolean;
  /** Force server mode (no fallback to local). */
  server?: boolean;
  repo?: string;
  mode?: ReviewMode;
  security?: boolean;
  json?: boolean;
  agent?: boolean;
  failOn?: Severity;
  maxFindings?: number;
  quiet?: boolean;
}

/** Server reviews run inside one request; give the server its full timeout plus transfer time. */
const SERVER_REVIEW_TIMEOUT_MS = 16 * 60_000;

function emptyResult(fullName: string, baseSha: string, head: string, mode: ReviewMode, focus: ReviewFocus | null): LocalReviewResult {
  return {
    repository: { id: null, fullName },
    baseSha,
    headSha: head,
    mode,
    focus,
    summary: { overview: "No changes to review.", whatChanged: [], affectedAreas: [], riskLevel: "low", riskRationale: "Nothing changed.", confidence: 5 },
    findings: [],
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    filesReviewed: 0,
    filesSkipped: [],
    rejected: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null, calls: 0, credits: 0 },
    models: {},
    durationMs: 0,
    warnings: [],
  };
}

interface Target {
  root: string;
  fullName: string;
  branch: string | null;
  head: string;
  base: { ref: string; sha: string };
  change: ChangeSet;
}

async function headContents(target: Target, paths: string[], limits: { perFile: number; total: number }): Promise<{ files: Record<string, string>; omitted: string[] }> {
  const files: Record<string, string> = {};
  const omitted: string[] = [];
  let total = 0;
  for (const p of paths) {
    const content = target.change.worktree ? await worktreeFile(target.root, p) : await showFile(target.root, "HEAD", p);
    if (content === null) continue;
    if (content.length > limits.perFile || total + content.length > limits.total) {
      omitted.push(p);
      continue;
    }
    files[p] = content;
    total += content.length;
  }
  return { files, omitted };
}

const serverResponseSchema = z.object({ review: localReviewResultSchema });

async function serverReview(ctx: Ctx, api: ApiClient, repositoryId: number, target: Target, opts: ReviewOptions): Promise<LocalReviewResult> {
  const live = target.change.files.filter((f) => f.status !== "removed").map((f) => f.path);
  const { files: headFiles, omitted } = await headContents(target, live, { perFile: LOCAL_REVIEW_LIMITS.maxFileBytes, total: LOCAL_REVIEW_LIMITS.maxTotalContentBytes });
  if (omitted.length) ctx.note(`Sending ${omitted.length} large file${omitted.length === 1 ? "" : "s"} as diff only: ${omitted.slice(0, 5).join(", ")}${omitted.length > 5 ? ", …" : ""}`);
  const body: LocalReviewBody = {
    repositoryId,
    baseSha: target.base.sha,
    headSha: target.change.worktree ? `${target.head}+dirty` : target.head,
    baseRef: target.base.ref,
    ...(target.branch ? { headRef: target.branch } : {}),
    files: target.change.files,
    headFiles,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.security ? { focus: "security" as const } : {}),
  };
  ctx.note(`Reviewing ${target.change.files.length} changed file${target.change.files.length === 1 ? "" : "s"} on ${api.server}…`);
  try {
    const res = await api.json("POST", "/api/v1/reviews/local", serverResponseSchema, { body, timeoutMs: SERVER_REVIEW_TIMEOUT_MS });
    return res.review;
  } catch (err) {
    if (err instanceof ApiResponseError && err.status === 409) throw new CliError(err.message, "Run `openreview review --local` to review without the server's index.");
    if (err instanceof ApiResponseError && err.status === 503) throw new CliError(`The server couldn't run the review: ${err.message}`, "Try again later, or review with --local.");
    if (err instanceof ApiResponseError && err.status === 504) throw new CliError(err.message, "Try --mode fast, a narrower --base, or --local.");
    throw err;
  }
}

/** Server mode when logged in and the repository is connected (unless --local); otherwise local mode. */
async function chooseMode(ctx: Ctx, target: Target, opts: ReviewOptions): Promise<{ kind: "local" } | { kind: "server"; api: ApiClient; repositoryId: number }> {
  if (opts.local) return { kind: "local" };
  const auth = await resolveAuth(ctx.io);
  if (!auth) {
    if (opts.server) throw new CliError("You're not logged in to an OpenReview server.", "Run `openreview login`, or drop --server to review locally.");
    ctx.note("Not logged in to a server: reviewing locally.");
    return { kind: "local" };
  }
  const api = new ApiClient(ctx.io, auth.server, auth.token);
  const repo = await findRepository(api, target.fullName);
  if (!repo) {
    if (opts.server || opts.repo) throw new CliError(`${target.fullName} is not connected to ${auth.server}.`, "Connect it in the dashboard, or review with --local.");
    ctx.note(`${target.fullName} is not connected to ${auth.server}: reviewing locally.`);
    return { kind: "local" };
  }
  return { kind: "server", api, repositoryId: repo.id };
}

export async function review(ctx: Ctx, opts: ReviewOptions): Promise<number> {
  const root = await repoRoot(ctx.io.cwd);
  const head = await headSha(root);
  const branch = await currentBranch(root);
  const base = await resolveBase(root, opts.base);
  const fullName = opts.repo ?? (await remoteRepo(root)) ?? path.basename(root);
  const change = await collectChanges(root, base.sha, opts.includeUncommitted ?? false);
  const target: Target = { root, fullName, branch, head, base, change };
  const focus: ReviewFocus | null = opts.security ? "security" : null;

  for (const f of change.files) {
    if (f.patch !== undefined && f.patch.length > LOCAL_REVIEW_LIMITS.maxPatchBytes) delete f.patch;
  }

  let result: LocalReviewResult;
  let source: "server" | "local" = "local";
  if (!change.files.length) {
    if (!opts.includeUncommitted) {
      const dirty = (await collectChanges(root, "HEAD", true)).files.length > 0;
      if (dirty) ctx.note("Your uncommitted changes are not included; add --include-uncommitted to review them.");
    }
    ctx.note(`No changes between ${branch ?? "HEAD"} and ${base.ref}.`);
    result = emptyResult(fullName, base.sha, head, opts.mode ?? "standard", focus);
  } else {
    const mode = await chooseMode(ctx, target, opts);
    if (mode.kind === "server") {
      if (change.files.length > LOCAL_REVIEW_LIMITS.maxFiles) {
        throw new CliError(`The change touches ${change.files.length} files; server reviews take at most ${LOCAL_REVIEW_LIMITS.maxFiles}.`, "Review a narrower range with --base, or use --local.");
      }
      result = await serverReview(ctx, mode.api, mode.repositoryId, target, opts);
      source = "server";
    } else {
      result = await runLocalReview(ctx.io, {
        root,
        repoName: fullName,
        base,
        headSha: change.worktree ? `${head}+dirty` : head,
        change,
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(focus ? { focus } : {}),
        progress: (m) => ctx.note(m),
        warn: (m) => ctx.warn(m),
      });
    }
  }

  // Partial model failures are surfaced (stderr), never silently treated as a clean review.
  for (const w of result.warnings) ctx.warn(w);
  const exitCode = failsOn(result.findings, opts.failOn ?? null) ? EXIT.findings : EXIT.ok;
  const sorted = sortFindings(result.findings);
  const shown = opts.maxFindings === undefined ? sorted : sorted.slice(0, opts.maxFindings);
  if (opts.json) {
    const out: CliReviewJson = {
      version: 1,
      source,
      ...result,
      findings: shown,
      baseRef: base.ref,
      headRef: branch,
      truncated: sorted.length - shown.length,
      failOn: opts.failOn ?? null,
      exitCode,
    };
    ctx.out(JSON.stringify(out, null, 2));
  } else if (opts.agent) {
    ctx.out(renderAgent({ header: agentHeader(result, base.ref), findings: findingsForAgent(result.findings), ...(opts.maxFindings !== undefined ? { maxFindings: opts.maxFindings } : {}) }));
  } else {
    const contents = new Map<string, string>();
    for (const p of new Set(shown.map((f) => f.path))) {
      const c = change.worktree ? await worktreeFile(root, p) : await showFile(root, "HEAD", p);
      if (c !== null) contents.set(p, c);
    }
    ctx.out(
      renderHuman(result, {
        color: ctx.color,
        quiet: opts.quiet ?? false,
        files: contents,
        source,
        baseRef: base.ref,
        ...(opts.maxFindings !== undefined ? { maxFindings: opts.maxFindings } : {}),
      }),
    );
  }
  if (exitCode === EXIT.findings && !opts.json) ctx.note(`Exiting with 1: found issues at or above ${opts.failOn}.`);
  return exitCode;
}
