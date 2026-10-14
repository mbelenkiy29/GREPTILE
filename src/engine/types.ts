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
] as const;
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
  })
  .refine((f) => f.endLine >= f.startLine, "Invalid line range");
export type Candidate = z.infer<typeof findingSchema>;
export type Finding = Candidate & {
  fingerprint: string;
  agent: string;
  commitSha: string;
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
export type ReviewInput = {
  coverageLimits?: string[];
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
};
export type ReviewResult = {
  summary: string;
  findings: Finding[];
  diagrams: string[];
  metadata: {
    reviewScore?: z.infer<typeof reviewScoreSchema>;
    approvalAssessment?: z.infer<typeof approvalAssessmentSchema>;
    coverageLimits?: string[];
    runtimeEvidence?: z.infer<typeof runtimeEvidenceSchema>;
    baseSha: string;
    headSha: string;
    mode: string;
    context: { path: string; reason: string; provenance?:SourceFile["provenance"] }[];
    candidates: number;
    suppressed: number;
    suppressions?: { title: string; agent: string; reason: string }[];
    carriedForward?: Finding[];
    resolvedFingerprints: string[];
  };
  usage: ModelUsage[];
};
export type ModelRequest = {
  task: string;
  system: string;
  input: unknown;
  signal?: AbortSignal;
};
export interface ModelProvider {
  generate<T>(
    request: ModelRequest,
    schema: z.ZodType<T>,
  ): Promise<{ value: T; usage: ModelUsage }>;
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
