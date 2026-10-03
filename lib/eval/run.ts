/**
 * The evaluation harness (R6.24): for each case, build the base snapshot as a git repository, index it into an
 * ephemeral database with the real indexer, apply the pull request, run the real review engine (`runReview`), and
 * match its findings to the documented issues. Models come from the environment (live), from recordings in
 * `eval/recordings/<mode>/<case>.json` (replay, for CI), or live with every answer recorded (`--record`).
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { resolveConfig } from "@/lib/config/repo-config";
import { installations, orgs, repos } from "@/lib/db/schema";
import { runReview } from "@/lib/engine";
import type { ReviewOutput, ReviewRequest } from "@/lib/engine/types";
import { diffFiles, showFile } from "@/lib/git/local/repo";
import { indexTree } from "@/lib/indexer";
import { DEFAULT_MAX_FILE_BYTES } from "@/lib/indexer/filetypes";
import { listTree } from "@/lib/indexer/git";
import { FakeEmbeddings } from "@/lib/llm/fake";
import { loadRecording, RecordingLlm, ReplayLlm, saveRecording, type Recording } from "@/lib/llm/replay";
import type { EmbeddingProvider, LlmProvider, ReviewMode } from "@/lib/llm/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { engineSettingsOf } from "@/lib/review/local";
import { EVAL_ROOT, type EvalCase } from "./cases";
import { ephemeralDb } from "./db";
import { matchFindings, type EvalFinding, type MatchResult } from "./match";

const exec = promisify(execFile);

export const RECORDINGS_DIR = path.join(EVAL_ROOT, "recordings");
export const REPORTS_DIR = path.join(EVAL_ROOT, "reports");
const EVAL_ORG = "org_eval";

/** Where the model answers come from. */
export type ModelSource =
  /** Answers replayed from `<dir>/<mode>/<case>.json`; never touches the network. */
  | { kind: "replay"; dir?: string }
  /**
   * A configured model. `llm(caseId)` returns the provider for one case (normally the env gateway); with `recordDir`,
   * every answer is saved to `<recordDir>/<mode>/<case>.json` for later replay.
   */
  | { kind: "live"; provider: string; model: string; llm: (caseId: string) => LlmProvider; embedder?: EmbeddingProvider; recordDir?: string };

export interface EvalOptions {
  cases: EvalCase[];
  mode: ReviewMode;
  concurrency?: number;
  source: ModelSource;
  log?: Logger;
  now?: () => Date;
  clock?: () => number;
}

export interface CaseResult {
  id: string;
  title: string;
  kind: string;
  status: "ok" | "error";
  error?: string;
  /** Where this case's model answers came from (`recorded` / `scripted` replay, or `live`). */
  origin: "recorded" | "scripted" | "live";
  counts: MatchResult["counts"];
  precision: number | null;
  recall: number | null;
  latencyMs: number;
  tokens: { input: number; output: number };
  /** Estimated USD from the price table; null when the model has no known price. */
  costUsd: number | null;
  modelCalls: number;
  findings: EvalFinding[];
  truePositives: { issue: string; title: string; path: string; line: number }[];
  duplicates: { issue: string; title: string; path: string; line: number }[];
  falsePositives: { title: string; path: string; line: number; nonIssue: string | null }[];
  missed: { issue: string; file: string; lines: [number, number]; description: string }[];
  /** Candidates the engine's verifier dropped (not counted as findings). */
  rejected: number;
}

export interface EvalTotals {
  cases: number;
  errors: number;
  expected: number;
  truePositives: number;
  falsePositives: number;
  duplicates: number;
  missed: number;
  precision: number | null;
  recall: number | null;
  latencyMs: number;
  tokens: { input: number; output: number };
  costUsd: number | null;
}

export interface EvalReport {
  version: 1;
  generatedAt: string;
  mode: ReviewMode;
  source: { kind: "replay" | "live"; origin: "recorded" | "scripted" | "live" | "mixed"; provider: string; model: string };
  cases: CaseResult[];
  totals: EvalTotals;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await exec("git", ["-c", "user.name=OpenReview eval", "-c", "user.email=eval@openreview.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

export function recordingPath(dir: string, mode: ReviewMode, caseId: string): string {
  return path.join(dir, mode, `${caseId}.json`);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const ratio = (num: number, den: number) => (den === 0 ? null : Math.round((num / den) * 1000) / 1000);

function toEvalFinding(f: ReviewOutput["findings"][number]): EvalFinding {
  return {
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    category: f.category,
    severity: f.severity,
    confidence: f.confidence,
    title: f.title,
    description: f.description,
    impact: f.impact,
    suggestedFix: f.suggestedFix,
  };
}

interface Prepared {
  llm: LlmProvider;
  embedder: EmbeddingProvider | undefined;
  origin: CaseResult["origin"];
  finish: () => Promise<void>;
}

async function prepareModel(source: ModelSource, mode: ReviewMode, c: EvalCase): Promise<Prepared> {
  if (source.kind === "replay") {
    const file = recordingPath(source.dir ?? RECORDINGS_DIR, mode, c.id);
    let recording: Recording;
    try {
      recording = await loadRecording(file);
    } catch (err) {
      throw new Error(`no usable recording for ${c.id} in ${mode} mode (${path.relative(process.cwd(), file)}): ${errorMessage(err)}`);
    }
    return { llm: new ReplayLlm(recording, path.relative(process.cwd(), file)), embedder: new FakeEmbeddings(), origin: recording.origin, finish: async () => {} };
  }
  const inner = source.llm(c.id);
  if (!source.recordDir) return { llm: inner, embedder: source.embedder, origin: "live", finish: async () => {} };
  const recorder = new RecordingLlm(inner, { provider: source.provider, description: `Captured by \`pnpm eval --record\` on case ${c.id} (${mode} mode).` });
  const file = recordingPath(source.recordDir, mode, c.id);
  return {
    llm: recorder,
    embedder: source.embedder,
    origin: "live",
    finish: async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await saveRecording(file, recorder.recording());
    },
  };
}

/** Runs one case end to end; failures are reported in the result, never thrown. */
export async function runCase(c: EvalCase, opts: Omit<EvalOptions, "cases">): Promise<CaseResult> {
  const clock = opts.clock ?? (() => performance.now());
  const log = (opts.log ?? rootLog).child({ component: "eval", case: c.id });
  const empty = { expected: c.expected.length, truePositives: 0, falsePositives: 0, duplicates: 0, missed: c.expected.length };
  const base: Omit<CaseResult, "status" | "origin"> = {
    id: c.id,
    title: c.title,
    kind: c.kind,
    counts: empty,
    precision: null,
    recall: null,
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
    costUsd: null,
    modelCalls: 0,
    findings: [],
    truePositives: [],
    duplicates: [],
    falsePositives: [],
    missed: c.expected.map((e) => ({ issue: e.id, file: e.file, lines: e.lines, description: e.description })),
    rejected: 0,
  };
  let origin: CaseResult["origin"] = opts.source.kind === "live" ? "live" : "scripted";
  const work = await mkdtemp(path.join(tmpdir(), `openreview-eval-${c.id}-`));
  let database: Awaited<ReturnType<typeof ephemeralDb>> | undefined;
  try {
    const model = await prepareModel(opts.source, opts.mode, c);
    origin = model.origin;

    // The base snapshot as a repository, indexed with the real indexer.
    await cp(c.baseDir, work, { recursive: true });
    await git(work, ["init", "--quiet", "--initial-branch=main"]);
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "--quiet", "--no-verify", "-m", "base"]);
    const baseSha = await git(work, ["rev-parse", "HEAD"]);
    database = await ephemeralDb();
    const { db } = database;
    await db.insert(orgs).values({ id: EVAL_ORG, name: "Evaluation", slug: "evaluation" });
    const [inst] = await db.insert(installations).values({ orgId: EVAL_ORG, provider: "eval", externalId: 0, accountLogin: "eval" }).returning();
    const [repo] = await db.insert(repos).values({ orgId: EVAL_ORG, installationId: inst!.id, externalId: 0, fullName: `eval/${c.id}`, defaultBranch: "main" }).returning();
    const tree = await indexTree(
      { db, ...(model.embedder ? { embedder: model.embedder } : {}), maxFileBytes: DEFAULT_MAX_FILE_BYTES, log },
      { scope: { orgId: EVAL_ORG, repoId: repo!.id }, repoName: c.id, dir: work, entries: await listTree(work), kind: "full" },
    );
    await db.update(repos).set({ indexStatus: "ready", indexedSha: baseSha, indexedAt: new Date(), fileCount: tree.fileCount }).where(eq(repos.id, repo!.id));

    // The pull request.
    await git(work, ["apply", "--whitespace=nowarn", c.patchFile]);
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "--quiet", "--no-verify", "-m", c.pr.title]);
    const headSha = await git(work, ["rev-parse", "HEAD"]);
    const files = await diffFiles(work, baseSha, headSha);
    const config = resolveConfig(undefined, {}, [], null);
    const request: ReviewRequest = {
      orgId: EVAL_ORG,
      repo: { id: repo!.id, fullName: `eval/${c.id}`, defaultBranch: "main" },
      baseSha,
      headSha,
      pr: { number: 1, title: c.pr.title, body: c.pr.body, author: c.pr.author, baseRef: "main", headRef: "pr" },
      files: files.map((f) => ({ path: f.path, status: f.status, ...(f.previousPath ? { previousPath: f.previousPath } : {}), ...(f.patch !== undefined ? { patch: f.patch } : {}) })),
      readFile: (p, ref) => showFile(work, ref === "head" ? headSha : baseSha, p),
      mode: opts.mode,
      settings: engineSettingsOf(config.settings),
      rules: [],
      learned: [],
      contextDocs: [],
      existingComments: [],
      priorFindings: [],
      historicalFindings: [],
    };

    const started = clock();
    const output = await runReview({ db, llm: model.llm, ...(model.embedder ? { embedder: model.embedder } : {}), log }, request);
    const latencyMs = Math.round(clock() - started);
    await model.finish();
    const failed = output.agentRuns.filter((r) => r.status === "error");
    if (failed.length) throw new Error(`model calls failed: ${failed.map((r) => `${r.agent}: ${r.error ?? "error"}`).join("; ")}`);

    const findings = output.findings.map(toEvalFinding);
    const match = matchFindings(findings, c.expected, c.nonIssues);
    const where = (f: EvalFinding) => ({ title: f.title, path: f.path, line: f.startLine });
    return {
      ...base,
      status: "ok",
      origin,
      counts: match.counts,
      precision: match.precision,
      recall: match.recall,
      latencyMs,
      tokens: { input: output.usage.inputTokens + (output.usage.cacheReadTokens ?? 0) + (output.usage.cacheWriteTokens ?? 0), output: output.usage.outputTokens },
      costUsd: output.usage.costUsd,
      modelCalls: output.usage.calls,
      findings,
      truePositives: match.truePositives.map((t) => ({ issue: t.issue, ...where(t.finding) })),
      duplicates: match.duplicates.map((d) => ({ issue: d.issue, ...where(d.finding) })),
      falsePositives: match.falsePositives.map((f) => ({ ...where(f.finding), nonIssue: f.nonIssue })),
      missed: match.missed.map((e) => ({ issue: e.id, file: e.file, lines: e.lines, description: e.description })),
      rejected: output.rejected.length,
    };
  } catch (err) {
    log.warn("evaluation case failed", { error: errorMessage(err) });
    return { ...base, status: "error", origin, error: errorMessage(err, 1000) };
  } finally {
    await database?.close().catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}

export function totalsOf(results: CaseResult[]): EvalTotals {
  const ok = results.filter((r) => r.status === "ok");
  const sum = (f: (r: CaseResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const tp = sum((r) => r.counts.truePositives);
  const fp = sum((r) => r.counts.falsePositives);
  const expected = sum((r) => r.counts.expected);
  const costs = ok.map((r) => r.costUsd);
  return {
    cases: results.length,
    errors: results.length - ok.length,
    expected,
    truePositives: tp,
    falsePositives: fp,
    duplicates: sum((r) => r.counts.duplicates),
    missed: sum((r) => r.counts.missed),
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, expected),
    latencyMs: sum((r) => r.latencyMs),
    tokens: { input: sum((r) => r.tokens.input), output: sum((r) => r.tokens.output) },
    costUsd: costs.length && costs.every((c) => c !== null) ? Math.round(costs.reduce((a, c) => a + c!, 0) * 1e6) / 1e6 : null,
  };
}

/** Runs every case (`concurrency` at a time) and builds the report. */
export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const results = await mapLimit(opts.cases, opts.concurrency ?? 2, (c) => runCase(c, opts));
  const origins = new Set(results.map((r) => r.origin));
  const origin: EvalReport["source"]["origin"] = origins.size === 1 ? [...origins][0]! : "mixed";
  return {
    version: 1,
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    mode: opts.mode,
    source:
      opts.source.kind === "live"
        ? { kind: "live", origin, provider: opts.source.provider, model: opts.source.model }
        : { kind: "replay", origin, provider: "replay", model: origin === "scripted" ? "none (hand-written responses)" : "as recorded" },
    cases: results,
    totals: totalsOf(results),
  };
}
