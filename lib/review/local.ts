/**
 * Reviews of a local change (R3.5): what `openreview review` sends, in both of its modes, through the one review
 * engine (`runReview`). Server mode posts the diff and the changed files' contents to `POST /api/v1/reviews/local`,
 * which reviews them against the server's index of the repository ({@link runServerLocalReview}); nothing is posted
 * to the git host. Local mode builds the same request in-process against a PGlite index of the working tree.
 *
 * The change's base versions are rebuilt from the head contents and the unified diff ({@link reconstructBase}), so
 * the server needs no access to the developer's unpushed commits.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { resolveConfig } from "@/lib/config/repo-config";
import type { EffectiveSettings } from "@/lib/config/settings";
import { loadHistoricalFindings } from "@/lib/data/findings";
import { activeRulesForRepo } from "@/lib/data/rules";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { orgs, repos, usageEvents } from "@/lib/db/schema";
import { creditsFor, runReview } from "@/lib/engine";
import {
  SEVERITIES,
  type ChangedFileInput,
  type EngineDeps,
  type EngineSettings,
  type ReviewFocus,
  type ReviewMode,
  type ReviewOutput,
  type ReviewRequest,
} from "@/lib/engine/types";
import { learnedPreferencesForReview } from "@/lib/learning";
import { REVIEW_MODES, type EmbeddingProvider, type LlmProvider } from "@/lib/llm/types";
import type { Logger } from "@/lib/log";

/** Limits on what a CLI review may send (the endpoint's body limit is derived from them). */
export const LOCAL_REVIEW_LIMITS = {
  maxFiles: 300,
  /** Per head file; larger files are sent without content (the engine reviews their diff only). */
  maxFileBytes: 512 * 1024,
  /** All head contents together. */
  maxTotalContentBytes: 6 * 1024 * 1024,
  maxPatchBytes: 1024 * 1024,
} as const;
/** Request body limit of `POST /reviews/local`: contents and patches plus JSON overhead. */
export const LOCAL_REVIEW_MAX_BODY_BYTES = 10 * 1024 * 1024;

const FILE_STATUSES = ["added", "modified", "removed", "renamed", "copied", "changed"] as const;
const gitPath = z
  .string()
  .min(1)
  .max(1000)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "must be a relative path inside the repository");
const sha = z.string().regex(/^[0-9a-f]{7,64}$/, "must be a commit sha");

export const localReviewFileSchema = z.strictObject({
  path: gitPath,
  previousPath: gitPath.optional(),
  status: z.enum(FILE_STATUSES),
  patch: z.string().max(LOCAL_REVIEW_LIMITS.maxPatchBytes).optional(),
});
export type LocalReviewFile = z.infer<typeof localReviewFileSchema>;

export const localReviewBodySchema = z
  .strictObject({
    repositoryId: z.number().int().positive().max(2_147_483_647).optional(),
    repoFullName: z.string().trim().min(3).max(300).optional(),
    baseSha: sha,
    /** The head commit; the CLI adds `+dirty` when uncommitted changes are included. */
    headSha: z.string().regex(/^[0-9a-f]{7,64}(\+dirty)?$/, "must be a commit sha"),
    baseRef: z.string().max(300).optional(),
    headRef: z.string().max(300).optional(),
    files: z.array(localReviewFileSchema).min(1, "There are no changes to review.").max(LOCAL_REVIEW_LIMITS.maxFiles),
    /** Head contents of changed files (absent for removed files and files over the size limit). */
    headFiles: z.record(gitPath, z.string().max(LOCAL_REVIEW_LIMITS.maxFileBytes)).default({}),
    mode: z.enum(REVIEW_MODES).optional(),
    focus: z.enum(["security"]).optional(),
  })
  .refine((b) => (b.repositoryId === undefined) !== (b.repoFullName === undefined), { message: "Send exactly one of repositoryId or repoFullName." })
  .refine((b) => Object.values(b.headFiles).reduce((n, c) => n + c.length, 0) <= LOCAL_REVIEW_LIMITS.maxTotalContentBytes, {
    message: `Changed files' contents exceed ${LOCAL_REVIEW_LIMITS.maxTotalContentBytes / (1024 * 1024)} MB together.`,
  });
export type LocalReviewBody = z.infer<typeof localReviewBodySchema>;

// ---- results (the CLI's `--json` output and the endpoint's response share this shape)

const severity = z.enum(SEVERITIES);
export const localFindingSchema = z.object({
  fingerprint: z.string(),
  title: z.string(),
  description: z.string(),
  impact: z.string(),
  severity,
  confidence: z.number(),
  category: z.string(),
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  symbol: z.string().nullable(),
  suggestedFix: z.string(),
  suggestion: z.string().nullable(),
  evidence: z.array(z.object({ path: z.string(), startLine: z.number(), endLine: z.number(), snippet: z.string(), note: z.string() })),
  rule: z.object({ id: z.string(), text: z.string() }).nullable(),
});
export type LocalFinding = z.infer<typeof localFindingSchema>;

export const localReviewResultSchema = z.object({
  repository: z.object({ id: z.number().nullable(), fullName: z.string() }),
  baseSha: z.string(),
  headSha: z.string(),
  mode: z.enum(REVIEW_MODES),
  focus: z.enum(["security"]).nullable(),
  summary: z.object({
    overview: z.string(),
    whatChanged: z.array(z.string()),
    affectedAreas: z.array(z.string()),
    riskLevel: z.enum(["low", "medium", "high"]),
    riskRationale: z.string(),
    confidence: z.number(),
  }),
  findings: z.array(localFindingSchema),
  counts: z.object({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number() }),
  filesReviewed: z.number(),
  filesSkipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  rejected: z.number(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable(), calls: z.number(), credits: z.number() }),
  models: z.record(z.string(), z.string()),
  durationMs: z.number(),
  /** Model steps that failed while the review still completed (e.g. one reviewer agent). */
  warnings: z.array(z.string()),
});
export type LocalReviewResult = z.infer<typeof localReviewResultSchema>;

/** The engine's settings from effective review settings (R6.14). */
export function engineSettingsOf(s: EffectiveSettings): EngineSettings {
  return {
    minConfidence: s.minConfidence,
    minSeverity: s.minSeverity,
    maxComments: s.maxComments,
    categories: s.categories,
    ignoredPaths: s.ignore,
    customInstructions: s.customInstructions,
    commentStyle: s.commentStyle,
    model: s.model,
  };
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The base version of a file from its head version and the unified diff between them: each hunk's new-side lines
 * are replaced by its old-side lines. Returns null when the diff does not fit the head content (it was cut, or the
 * file changed since the diff was taken).
 */
export function reconstructBase(head: string, patch: string): string | null {
  const headLines = head.split("\n");
  const out: string[] = [];
  let cursor = 0; // next head line (0-based) not yet copied
  let oldNoNewline = false;
  let newNoNewline = false;
  let last: "add" | "del" | "ctx" | null = null;
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = HUNK.exec(lines[i]!);
    if (!h) continue;
    const newStart = Number(h[3]);
    const newCount = h[4] === undefined ? 1 : Number(h[4]);
    const oldCount = h[2] === undefined ? 1 : Number(h[2]);
    // A zero-length new side sits *after* line newStart.
    const firstNew = newCount === 0 ? newStart : newStart - 1;
    if (firstNew < cursor || firstNew > headLines.length) return null;
    out.push(...headLines.slice(cursor, firstNew));
    cursor = firstNew;
    let seenOld = 0;
    let seenNew = 0;
    for (i = i + 1; i < lines.length && (seenOld < oldCount || seenNew < newCount || lines[i]!.startsWith("\\")); i++) {
      const line = lines[i]!;
      if (line.startsWith("\\")) {
        if (last === "del") oldNoNewline = true;
        else if (last === "add") newNoNewline = true;
        else if (last === "ctx") oldNoNewline = newNoNewline = true;
        continue;
      }
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      const text = kind === "ctx" && !line.startsWith(" ") ? line : line.slice(1);
      last = kind;
      if (kind !== "del") {
        if (headLines[cursor] !== text) return null;
        cursor++;
        seenNew++;
      }
      if (kind !== "add") {
        out.push(text);
        seenOld++;
      }
    }
    i--;
  }
  out.push(...headLines.slice(cursor));
  // Trailing-newline bookkeeping: `split("\n")` leaves "" after a final newline.
  if (newNoNewline !== oldNoNewline) {
    if (oldNoNewline && out.at(-1) === "") out.pop();
    else if (!oldNoNewline) out.push("");
  }
  return out.join("\n");
}

/** The old side of a removed file's diff (the whole file). */
export function removedContent(patch: string): string {
  const lines = patch.split("\n");
  const old: string[] = [];
  let noNewline = false;
  for (const l of lines) {
    if (l.startsWith("-") && !l.startsWith("---")) old.push(l.slice(1));
    else if (l.startsWith("\\")) noNewline = true;
  }
  return old.join("\n") + (noNewline ? "" : "\n");
}

/** A reader of base and head versions for a change described by `files` and the head contents. */
export function changeReader(files: LocalReviewFile[], headFiles: Record<string, string>): ReviewRequest["readFile"] {
  const byBasePath = new Map(files.map((f) => [f.previousPath ?? f.path, f]));
  const heads = new Map(Object.entries(headFiles));
  return async (path, ref) => {
    if (ref === "head") return heads.get(path) ?? null;
    const f = byBasePath.get(path);
    if (!f || f.status === "added") return null;
    if (f.status === "removed") return f.patch ? removedContent(f.patch) : null;
    const head = heads.get(f.path);
    if (head === undefined) return null;
    return f.patch ? reconstructBase(head, f.patch) : head;
  };
}

/** Every reviewer agent's model call failed, so "no findings" would be a false all-clear. */
export class ReviewModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewModelError";
  }
}

const SUPPORT_AGENTS = new Set(["classifier", "verifier", "summarizer", "resolver"]);

/**
 * The engine keeps going when some model calls fail. A CLI review must not report a clean result when none of its
 * reviewers ran: this throws {@link ReviewModelError} then, and otherwise returns warnings for the agents that failed.
 */
export function modelFailureWarnings(output: ReviewOutput): string[] {
  const reviewers = output.agentRuns.filter((a) => !SUPPORT_AGENTS.has(a.agent) && a.status !== "skipped");
  const failed = reviewers.filter((a) => a.status === "error");
  if (reviewers.length > 0 && failed.length === reviewers.length) {
    throw new ReviewModelError(`Every review model call failed (${failed[0]!.error ?? "unknown error"}).`);
  }
  const warnings = failed.map((a) => `The ${a.agent} reviewer failed: ${a.error ?? "unknown error"}`);
  for (const a of output.agentRuns) if (SUPPORT_AGENTS.has(a.agent) && a.status === "error") warnings.push(`The ${a.agent} step failed: ${a.error ?? "unknown error"}`);
  return warnings;
}

/** Engine findings as the CLI and API report them. */
export function toLocalResult(
  output: ReviewOutput,
  meta: { repository: { id: number | null; fullName: string }; baseSha: string; headSha: string; credits: number },
): LocalReviewResult {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of output.findings) counts[f.severity]++;
  const warnings = modelFailureWarnings(output);
  return {
    warnings,
    repository: meta.repository,
    baseSha: meta.baseSha,
    headSha: meta.headSha,
    mode: output.metadata.mode,
    focus: output.metadata.focus,
    summary: {
      overview: output.summary.overview,
      whatChanged: output.summary.whatChanged,
      affectedAreas: output.summary.affectedAreas,
      riskLevel: output.summary.riskLevel,
      riskRationale: output.summary.riskRationale,
      confidence: output.summary.confidence,
    },
    findings: output.findings.map((f) => ({
      fingerprint: f.fingerprint,
      title: f.title,
      description: f.description,
      impact: f.impact,
      severity: f.severity,
      confidence: f.confidence,
      category: f.category,
      path: f.path,
      startLine: f.startLine,
      endLine: f.endLine,
      symbol: f.symbol,
      suggestedFix: f.suggestedFix,
      suggestion: f.suggestion,
      evidence: f.evidence,
      rule: f.rule,
    })),
    counts,
    filesReviewed: output.metadata.filesReviewed,
    filesSkipped: output.metadata.filesSkipped,
    rejected: output.rejected.length,
    usage: { inputTokens: output.usage.inputTokens, outputTokens: output.usage.outputTokens, costUsd: output.usage.costUsd, calls: output.usage.calls, credits: meta.credits },
    models: output.metadata.models,
    durationMs: output.metadata.durationMs,
  };
}

export interface ServerLocalReviewDeps {
  db: Db;
  llm: LlmProvider;
  embedder?: EmbeddingProvider;
  log?: Logger;
  /** The engine (tests may inject one); defaults to `runReview`. */
  runReview?: (deps: EngineDeps, req: ReviewRequest) => Promise<ReviewOutput>;
  signal?: AbortSignal;
}

export class LocalReviewError extends Error {
  constructor(
    readonly code: "not_found" | "not_indexed" | "archived",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reviews a CLI-submitted change against the server's index of the repository (R3.5): the org's settings, dashboard
 * rules, learned preferences, and past findings apply as in a pull request review; nothing is posted to the git
 * host. Records one `usage_events` row (trigger `cli`) with the run's tokens, cost, and credits.
 */
export async function runServerLocalReview(
  deps: ServerLocalReviewDeps,
  input: { orgId: string; body: LocalReviewBody; requestedBy: string },
): Promise<LocalReviewResult> {
  const { db } = deps;
  const { orgId, body } = input;
  const [row] = await db
    .select({ repo: repos, orgSettings: orgs.settings })
    .from(repos)
    .innerJoin(orgs, eq(orgs.id, repos.orgId))
    .where(scoped(repos, orgId, body.repositoryId !== undefined ? eq(repos.id, body.repositoryId) : eq(repos.fullName, body.repoFullName!)))
    .limit(1);
  if (!row) throw new LocalReviewError("not_found", "Repository not found in your organization. Connect it in the dashboard, or review with --local.");
  const { repo } = row;
  if (repo.archived) throw new LocalReviewError("archived", "The repository is archived and can't be reviewed.");
  if (!repo.indexedSha) {
    throw new LocalReviewError("not_indexed", `${repo.fullName} has not been indexed yet (status: ${repo.indexStatus}). Try again once indexing finishes, or review with --local.`);
  }
  const config = resolveConfig(repo.settings, undefined, [], row.orgSettings);
  const mode: ReviewMode = body.mode ?? config.settings.mode;
  const focus: ReviewFocus | undefined = body.focus;
  const files: ChangedFileInput[] = body.files.map((f) => ({ path: f.path, status: f.status, ...(f.previousPath ? { previousPath: f.previousPath } : {}), ...(f.patch !== undefined ? { patch: f.patch } : {}) }));
  const [dashboardRules, learned, historical] = await Promise.all([
    activeRulesForRepo(db, orgId, repo.id),
    learnedPreferencesForReview(db, orgId, repo.id),
    loadHistoricalFindings(db, orgId, { repoId: repo.id, excludeReviewId: 0, paths: files.map((f) => f.path) }),
  ]);
  const request: ReviewRequest = {
    orgId,
    repo: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch },
    baseSha: body.baseSha,
    headSha: body.headSha,
    files,
    readFile: changeReader(body.files, body.headFiles),
    mode,
    ...(focus ? { focus } : {}),
    settings: engineSettingsOf(config.settings),
    rules: [...dashboardRules, ...config.rules],
    learned,
    contextDocs: [],
    existingComments: [],
    priorFindings: [],
    historicalFindings: historical,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
  const engine = deps.runReview ?? runReview;
  const output = await engine({ db, llm: deps.llm, ...(deps.embedder ? { embedder: deps.embedder } : {}), ...(deps.log ? { log: deps.log } : {}) }, request);
  const credits = creditsFor(mode);
  // Throws when no reviewer ran (then no credits are charged; the failed calls stay in model_calls).
  const result = toLocalResult(output, { repository: { id: repo.id, fullName: repo.fullName }, baseSha: body.baseSha, headSha: body.headSha, credits });
  await db.insert(usageEvents).values({
    orgId,
    repoId: repo.id,
    author: input.requestedBy,
    kind: "review",
    trigger: "cli",
    inputTokens: output.usage.inputTokens,
    outputTokens: output.usage.outputTokens,
    costUsd: output.usage.costUsd,
    credits,
  });
  return result;
}
