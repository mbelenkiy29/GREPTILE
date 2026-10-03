import type {
  EngineDeps,
  EngineFinding,
  EngineStage,
  RejectedCandidate,
  ReviewOutput,
  ReviewRequest,
} from "@/lib/engine/types";
import type { RunReview } from "@/lib/pipeline/engine";

/** An accepted finding with every field filled; override what the test cares about. */
export function engineFinding(over: Partial<EngineFinding> = {}): EngineFinding {
  return {
    fingerprint: "fp-callers-break",
    title: "Callers break",
    description: "Two callers still pass one argument.",
    impact: "Checkout throws at runtime.",
    severity: "high",
    confidence: 0.9,
    category: "correctness",
    agents: ["correctness", "api_compat"],
    path: "services/billing/pricing.ts",
    startLine: 3,
    endLine: 3,
    symbol: "computeTotal",
    anchorCode: "export function computeTotal(items: number[], region: string) {",
    evidence: [{ path: "services/api/handlers.ts", startLine: 4, endLine: 4, snippet: "computeTotal(req.items)", note: "caller passes one argument" }],
    suggestedFix: "Give `region` a default value.",
    suggestion: 'export function computeTotal(items: number[], region = "default") {',
    rule: null,
    verification: {
      verdict: "accept",
      reasons: ["caller found in services/api/handlers.ts"],
      checks: { grounded: true, codeAccurate: true, introducedByPr: true, actionable: true, nonTrivial: true, notDuplicate: true },
    },
    priorFindingId: null,
    ...over,
  };
}

export function rejectedCandidate(over: Partial<RejectedCandidate> = {}): RejectedCandidate {
  return {
    title: "Possible null dereference",
    category: "correctness",
    agent: "correctness",
    path: "services/billing/pricing.ts",
    startLine: 4,
    severity: "medium",
    confidence: 0.3,
    stage: "verifier",
    reason: "items is validated by the caller",
    ...over,
  };
}

/** A complete engine output; override parts per test. */
export function reviewOutput(
  over: Partial<Omit<ReviewOutput, "metadata">> & { metadata?: Partial<ReviewOutput["metadata"]> } = {},
): ReviewOutput {
  const { metadata, ...rest } = over;
  return {
    summary: {
      overview: "Adds tax to totals.",
      whatChanged: ["computeTotal adds tax", "computeTotal takes a region"],
      affectedAreas: ["services/billing"],
      riskLevel: "high",
      riskRationale: "Signature change breaks two callers.",
      confidence: 2,
      architectureImpact: null,
      relevantTests: [],
      diagram: null,
    },
    findings: [],
    rejected: [],
    resolvedPriorFindings: [],
    classification: { subsystems: ["services/billing"], languages: ["ts"], riskAreas: [], dependencyImpact: [], agents: [], skippedAgents: [] },
    context: { items: [], tokensUsed: 0, tokenBudget: 10_000, dropped: 0 },
    agentRuns: [
      {
        agent: "correctness",
        status: "ok",
        model: "fake-model",
        usage: { inputTokens: 1200, outputTokens: 300 },
        costUsd: 0.0123,
        latencyMs: 850,
        candidates: 2,
        accepted: 1,
      },
    ],
    usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.0123, calls: 1 },
    metadata: {
      mode: "standard",
      focus: null,
      models: { review: "fake-model" },
      filesReviewed: 1,
      filesSkipped: [],
      durationMs: 1000,
      stageTimings: {},
      incremental: false,
      ...metadata,
    },
    ...rest,
  };
}

const STAGES: EngineStage[] = ["ingesting", "retrieving_context", "reviewing", "verifying", "summarizing"];

/**
 * A stand-in engine honoring the S39 contract: it walks the stages through `onStage`, runs the test's per-stage
 * actions (e.g. model calls, or cancelling the run), reports agent runs, and returns the canned output.
 */
export function stubEngine(
  output: (req: ReviewRequest, deps: EngineDeps) => ReviewOutput | Promise<ReviewOutput>,
  during: Partial<Record<EngineStage, (req: ReviewRequest, deps: EngineDeps) => Promise<void> | void>> = {},
) {
  const calls: ReviewRequest[] = [];
  const stages: EngineStage[] = [];
  const run: RunReview = async (deps, req) => {
    calls.push(req);
    for (const stage of STAGES) {
      await deps.hooks?.onStage?.(stage);
      stages.push(stage);
      await during[stage]?.(req, deps);
    }
    const out = await output(req, deps);
    for (const a of out.agentRuns) await deps.hooks?.onAgentRun?.(a);
    return out;
  };
  return { run, calls, stages };
}
