import { z } from "zod";
import { runtimeRevisionSchema } from "../runtime-revision";

export const categories = [
  "correctness",
  "security",
  "data",
  "compatibility",
  "testing",
  "performance",
  "rules",
  // Opt-in (not in the default category set): convention-backed style and syntax checks.
  "style",
  "syntax",
] as const;
export const optInCategories = ["style", "syntax"] as const;
export const defaultCategories = categories.filter((c) => !(optInCategories as readonly string[]).includes(c));
export const severities = ["critical", "high", "medium", "low"] as const;
export const reviewScoreSchema = z.object({
  value: z.number().int().min(0).max(5),
  reason: z.string().min(20).max(2000),
});
export const approvalAssessmentSchema = z.object({
  risk: z.enum(["low", "medium", "high", "unknown"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(20).max(2000),
});
export const runtimeEvidenceSchema = z.object({
  headSha: runtimeRevisionSchema,
  image: z.string().regex(/^[-a-zA-Z0-9_./:]+@sha256:[a-f0-9]{64}$/),
  command: z.string().min(1).max(2000),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  executionStarted:z.boolean().optional(),
  output: z.string().max(20000),
  outputTruncated: z.boolean(),
  network: z.literal("none"),
  memoryMb: z.literal(512),
  cpus: z.literal(1),
});
export const findingSchema = z
  .object({
    title: z.string().min(5).max(200),
    description: z.string().min(15).max(5000),
    severity: z.enum(severities),
    confidence: z.number().min(0).max(1),
    category: z.enum(categories),
    filePath: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    evidence: z
      .array(
        z.object({
          filePath: z.string(),
          startLine: z.number().int().positive(),
          quote: z.string().min(1),
          repository: z.string().optional(),
          revision: z.string().optional(),
          sourceUrl: z.string().url().refine(value=>new URL(value).protocol==="https:","Source links require HTTPS").optional(),
        }),
      )
      .min(1)
      .max(10),
    impact: z.string().min(5),
    suggestedFix: z.string().min(5),
    symbol: z.string(),
    ruleId: z.string().optional(),
    // Optional question to the author when the change's intent is unclear; shown under the
    // comment. It never counts as a finding or blocks approval on its own.
    question: z.string().min(5).max(300).optional(),
    // Optional committable fix: replaces lines startLine..endLine (the finding's own range);
    // original must copy those head lines exactly. Dropped when it does not apply cleanly.
    suggestion: z.object({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      original: z.string().max(20000),
      replacement: z.string().max(10000),
    }).optional(),
  })
  .refine((f) => f.endLine >= f.startLine, "Invalid line range");
export type Candidate = z.infer<typeof findingSchema>;
export type Finding = Candidate & {
  fingerprint: string;
  agent: string;
  commitSha: string;
  // Anchored on a line the change did not modify (e.g. a caller it breaks); its evidence quotes a
  // changed line. Published only in the summary, never as an inline comment.
  outsideDiff?: boolean;
  // Recorded result of a generated reproduction test run in the sandbox (J3).
  generatedTest?: { path: string; command: string; code: string; status: "reproduced" | "not reproduced" | "inconclusive"; exitCode?: number | null; timedOut: boolean; executionStarted: boolean; output: string };
};
export type SourceFile = { path: string; content: string; sha: string; size?: number; provenance?: { repository: string; revision: string; sourceUrl: string } };
export type ChangedFile = {
  path: string;
  previousPath?: string;
  patch: string;
  status: string;
};
export type Rule = {
  id: string;
  instructions: string;
  severity: (typeof severities)[number];
  category: string;
  globs: string[];
  enabled: boolean;
};
export type Preference = { category: string; instruction: string };
export type SkippedFile = { path: string; reason: string };
export type ReviewInput = {
  coverageLimits?: string[];
  // Changed files the provider could not supply (e.g. omitted diffs); reported, never reviewed.
  skippedFiles?: SkippedFile[];
  // Complete pull-request diff when `diff` holds only new commits (incremental review): findings
  // must also anchor on lines the PR changes, and the summary lists every PR file.
  fullDiff?: ChangedFile[];
  // Provider link to file lines at the reviewed revision (summary issue table); optional.
  sourceLink?: (path: string, startLine: number, endLine: number) => string | undefined;
  runtimeEvidence?: z.infer<typeof runtimeEvidenceSchema>;
  contextHints?: { path: string; reason: string; score: number }[];
  repository: string;
  baseSha: string;
  headSha: string;
  title: string;
  description: string;
  files: SourceFile[];
  diff: ChangedFile[];
  rules: Rule[];
  preferences?: Preference[];
  // Knowledge base entries about the changed code (derived background; never evidence).
  knowledge?: { subsystem: string; description: string; risks: string[]; conventions: string[]; files: string[] }[];
  mode: "fast" | "standard" | "deep";
  existingFindings?: Finding[];
  historicalFindings?: (Pick<
    Finding,
    "title" | "category" | "severity" | "filePath" | "impact"
  > & { status: string })[];
  settings?: {
    minimumConfidence?: number;
    severityThreshold?: (typeof severities)[number];
    maxComments?: number;
    categories?: (typeof categories)[number][];
    ignoredPaths?: string[];
    instructions?: string;
    summarySections?: string[];
    // Deterministic security checks and dependency advisories (default on).
    securityScan?: boolean;
  };
};
export type ModelUsage = {
  task: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCost: number;
  cached: boolean;
  // Subsets of inputTokens served from / written to the provider prompt cache.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};
export type ReviewResult = {
  summary: string;
  findings: Finding[];
  diagrams: string[];
  metadata: {
    reviewScore?: z.infer<typeof reviewScoreSchema>;
    verdict?: "ready" | "fixes" | "changes" | "incomplete";
    // Changed code went unreviewed (skipped files, failed specialists, unavailable sources or an
    // exhausted agent budget), so the verdict cannot be "ready".
    coverageIncomplete?: boolean;
    approvalAssessment?: z.infer<typeof approvalAssessmentSchema>;
    coverageLimits?: string[];
    skippedFiles?: SkippedFile[];
    failedSpecialists?: { category: string; error: string }[];
    engine?: "pipeline" | "agentic" | "hypotheses";
    hypotheses?: { id: number; claim: string; category: string; filePath: string; startLine: number; status: string; stopReason?: string; toolCalls: number; turns: number; reported: number }[];
    agentRun?: { toolCalls: number; turns: number; resumes: number; stopReason?: string };
    runtimeEvidence?: z.infer<typeof runtimeEvidenceSchema>;
    baseSha: string;
    headSha: string;
    mode: string;
    context: { path: string; reason: string; provenance?:SourceFile["provenance"] }[];
    candidates: number;
    suppressed: number;
    suppressions?: { title: string; agent: string; reason: string }[];
    carriedForward?: Finding[];
    exploitability?: { fingerprint: string; exploitPath: boolean }[];
    knowledge?: string[];
    resolvedFingerprints: string[];
  };
  usage: ModelUsage[];
};
export type ModelRequest = {
  task: string;
  system: string;
  input: unknown;
  // Large shared data sent before `input` as a stable, cacheable prompt prefix
  // (e.g. the review payload shared by every specialist). Untrusted, like input.
  context?: unknown;
  signal?: AbortSignal;
};
// JSON Schema object describing a tool's input; results are always untrusted data.
export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolMessage =
  | { role: "user"; content: string }
  // providerContent is the provider's raw assistant turn, replayed verbatim (thinking blocks must not be edited).
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; providerContent?: unknown; provider?: string }
  | { role: "tool"; results: { id: string; content: string; isError?: boolean }[] };
export type ToolRequest = {
  task: string;
  system: string;
  context?: unknown;
  messages: ToolMessage[];
  tools: ToolDefinition[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
};
export type ToolTurn = {
  content: string;
  toolCalls: ToolCall[];
  stopReason: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "other";
  message: Extract<ToolMessage, { role: "assistant" }>;
  usage: ModelUsage;
};
export interface ModelProvider {
  generate<T>(
    request: ModelRequest,
    schema: z.ZodType<T>,
  ): Promise<{ value: T; usage: ModelUsage }>;
  // One model turn with native tool calling; callers own the transcript and execute tools.
  runTools?(request: ToolRequest): Promise<ToolTurn>;
}
export const stages = [
  "queued",
  "ingesting",
  "retrieving_context",
  "reviewing",
  "verifying",
  "summarizing",
  "publishing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type Stage = (typeof stages)[number];
