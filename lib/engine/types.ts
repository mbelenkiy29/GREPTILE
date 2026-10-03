/**
 * The shared review engine contract (S39). GitHub pull requests, the CLI (server and local mode), the REST API, the
 * MCP server, and demo mode all review code through `runReview(deps, request)`; none of them re-implements review
 * logic. The engine is independent of any git host: callers supply the diff and a file reader, and the engine reads
 * the repository index (graph, full text, embeddings) through the database it is given.
 */
import type { Db } from "@/lib/db";
import type { EmbeddingProvider, LlmProvider, ReviewMode, Usage } from "@/lib/llm/types";
import type { Logger } from "@/lib/log";
import type { ReviewRule } from "@/lib/rules";

export type { ReviewMode };

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Specialized reviewers (R6.7). */
export const AGENT_IDS = ["correctness", "security", "data", "api_compat", "testing", "performance", "rules"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Finding categories shown to users; one per agent plus categories the security profile emits. */
export type FindingCategory = AgentId;

export type ReviewFocus = "security";

export type EngineStage = "ingesting" | "retrieving_context" | "reviewing" | "verifying" | "summarizing";

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  url?: string;
  commits?: { sha: string; message: string; author: string }[];
  /** Failing/pending CI checks on the head commit, if known. */
  checks?: { name: string; status: string; conclusion: string | null }[];
}

export interface ChangedFileInput {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  /** Unified diff hunks; absent for binary or huge files. */
  patch?: string;
}

/** A comment already on the pull request (ours or a human's); used to avoid repeating what is already said. */
export interface ExistingComment {
  id: number;
  author: string;
  body: string;
  path?: string;
  line?: number | null;
  /** Fingerprint marker if the comment was posted by OpenReview. */
  fingerprint?: string | null;
}

/** An open finding from an earlier run on this pull request (incremental tracking, R6.9). */
export interface PriorFinding {
  id: number;
  fingerprint: string;
  title: string;
  description: string;
  category: FindingCategory;
  severity: Severity;
  path: string;
  startLine: number;
  endLine: number;
  /** Code the finding was anchored to when it was raised (normalized). */
  anchorCode: string;
  symbol: string | null;
}

/** A prior finding that stays open after a review run (see `ReviewOutput.openPriorFindings`). */
export type OpenPriorFinding = Pick<PriorFinding, "id" | "title" | "severity" | "category" | "path" | "startLine">;

/** A past finding elsewhere in the repository, offered as historical context (R6.5). */
export interface HistoricalFinding {
  title: string;
  category: FindingCategory;
  path: string;
  status: string;
  feedback?: "useful" | "not_useful" | "false_positive" | "wont_fix" | null;
}

export interface LearnedPreference {
  category: string;
  description: string;
  signal: "suppress" | "boost" | "neutral";
  /**
   * `pattern` (the default) covers findings of the category whose title matches the description; a suppress
   * pattern drops them. `category` covers every finding of the category: a suppress raises the category's minimum
   * confidence by `confidenceDelta` (it does not block), a boost ranks the category higher (R6.10).
   */
  appliesTo?: "pattern" | "category";
  /** Category suppressions: added to `settings.minConfidence` for the category. */
  confidenceDelta?: number;
}

export interface ContextDoc {
  path: string;
  content: string;
}

export interface EngineSettings {
  /** 0..1; findings below are not published. */
  minConfidence: number;
  minSeverity: Severity;
  maxComments: number;
  /** Agents allowed to run (subset of AGENT_IDS). */
  categories: AgentId[];
  ignoredPaths: string[];
  customInstructions: string | null;
  commentStyle: "concise" | "detailed";
  /** Explicit model override for review/verify tasks (else the gateway's routing). */
  model: string | null;
}

export interface ReviewRequest {
  /** Tenant the index belongs to (CLI local mode uses a local org id). */
  orgId: string;
  repo: { id: number; fullName: string; defaultBranch: string };
  baseSha: string;
  headSha: string;
  pr?: PullRequestInfo;
  files: ChangedFileInput[];
  /** File contents at the base or head commit; null when the file does not exist there. */
  readFile(path: string, ref: "base" | "head"): Promise<string | null>;
  mode: ReviewMode;
  focus?: ReviewFocus;
  settings: EngineSettings;
  rules: ReviewRule[];
  learned: LearnedPreference[];
  contextDocs: ContextDoc[];
  existingComments: ExistingComment[];
  priorFindings: PriorFinding[];
  historicalFindings: HistoricalFinding[];
  /** Re-review: only files changed since `sinceSha` are re-reviewed; prior findings there are re-checked. */
  incremental?: { sinceSha: string; changedPaths: string[] };
  /** Correlation ids passed to the model gateway for accounting. */
  meta?: { reviewRunId?: number };
  signal?: AbortSignal;
}

export interface EngineHooks {
  /** Called when the engine enters a stage; may throw (e.g. CancelledError) to stop the review. */
  onStage?(stage: EngineStage): Promise<void>;
  onAgentRun?(run: AgentRunRecord): Promise<void>;
}

export interface EngineDeps {
  db: Db;
  /**
   * Normally the model gateway (`llm({ db })`); its results carry the route that ran, used to record models and
   * cost. A bare provider (tests) works too: costs are then estimated from `llm.model`.
   */
  llm: LlmProvider;
  embedder?: EmbeddingProvider;
  log?: Logger;
  hooks?: EngineHooks;
  now?: () => number;
}

export interface Evidence {
  path: string;
  startLine: number;
  endLine: number;
  /** Code excerpt (verified to exist in the head commit or the index). */
  snippet: string;
  note: string;
}

export interface Verification {
  verdict: "accept" | "reject";
  reasons: string[];
  checks: {
    grounded: boolean;
    codeAccurate: boolean;
    introducedByPr: boolean;
    actionable: boolean;
    nonTrivial: boolean;
    notDuplicate: boolean;
  };
}

export interface EngineFinding {
  fingerprint: string;
  title: string;
  description: string;
  impact: string;
  severity: Severity;
  /** 0..1 */
  confidence: number;
  category: FindingCategory;
  /** Agent that raised it first, then any agents that independently agreed. */
  agents: AgentId[];
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  /** Normalized code at the anchor (for cross-commit tracking). */
  anchorCode: string;
  evidence: Evidence[];
  suggestedFix: string;
  /** Exact replacement for startLine..endLine (GitHub suggestion block), or null. */
  suggestion: string | null;
  rule: { id: string; text: string } | null;
  verification: Verification;
  /** When this finding matches an open prior finding (same issue after a push). */
  priorFindingId: number | null;
}

export interface RejectedCandidate {
  title: string;
  category: FindingCategory;
  agent: AgentId;
  path: string;
  startLine: number;
  severity: Severity;
  confidence: number;
  stage: "anchor" | "filter" | "duplicate" | "existing_comment" | "verifier" | "learned" | "cap";
  reason: string;
}

export interface ChangeClassification {
  subsystems: string[];
  languages: string[];
  riskAreas: string[];
  dependencyImpact: string[];
  agents: { id: AgentId; reason: string }[];
  skippedAgents: { id: AgentId; reason: string }[];
}

export interface ReviewSummary {
  overview: string;
  whatChanged: string[];
  affectedAreas: string[];
  riskLevel: "low" | "medium" | "high";
  riskRationale: string;
  /** 1 (will cause problems) .. 5 (safe to merge) */
  confidence: number;
  architectureImpact: string | null;
  relevantTests: { path: string; note: string }[];
  /** Mermaid diagram source, only when it adds value. */
  diagram: string | null;
}

export interface AgentRunRecord {
  agent: AgentId | "classifier" | "verifier" | "summarizer" | "resolver";
  status: "ok" | "error" | "skipped";
  model: string | null;
  usage: Usage;
  costUsd: number | null;
  latencyMs: number;
  candidates: number;
  accepted: number;
  error?: string;
}

export interface ContextItemSummary {
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  name: string | null;
  reasons: string[];
  tokens: number;
  /** Retrieval rank score (higher is more relevant). */
  score?: number;
}

/** Outcome of running the repository's tests in the sandbox (R4.5), attached to the review it ran for. */
export interface RuntimeValidationResult {
  status: "passed" | "failed" | "timeout" | "error" | "skipped";
  image: string;
  network: "none" | "install-only";
  /** The step that failed, or null. */
  failedStep: "install" | "test" | null;
  /** The failing command (or the test command when nothing failed). */
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  /** Captured output: capped (head and tail kept), control characters stripped, secrets redacted. */
  outputExcerpt: string;
  /** Failing test names recognized in the output. */
  failingTests: string[];
  /** Why it was skipped or errored, and notes (e.g. the install ran offline). */
  reason: string | null;
}

export interface ReviewOutput {
  summary: ReviewSummary;
  findings: EngineFinding[];
  rejected: RejectedCandidate[];
  /** Prior findings (by id) the engine determined were fixed by the new commits. */
  resolvedPriorFindings: { id: number; reason: string }[];
  /**
   * Prior findings still open after this run that this run did not re-report (in incremental re-reviews, findings in
   * files untouched since the last review). The summary and its counts cover them so they describe the whole PR.
   */
  openPriorFindings?: OpenPriorFinding[];
  classification: ChangeClassification;
  /** Runtime validation of the PR head (R4.5), when the repository enables it; added by the review job. */
  runtimeValidation?: RuntimeValidationResult;
  context: { items: ContextItemSummary[]; tokensUsed: number; tokenBudget: number; dropped: number };
  agentRuns: AgentRunRecord[];
  usage: Usage & { costUsd: number | null; calls: number };
  metadata: {
    mode: ReviewMode;
    focus: ReviewFocus | null;
    models: Record<string, string>;
    filesReviewed: number;
    filesSkipped: { path: string; reason: string }[];
    durationMs: number;
    stageTimings: Partial<Record<EngineStage, number>>;
    incremental: boolean;
  };
}

export class CancelledError extends Error {
  constructor(message = "review cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}
