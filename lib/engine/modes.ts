/**
 * Review modes (R4.1). Fast, standard, and deep differ in how many specialized agents run, how much repository
 * context they see, how far retrieval walks the graph, and (through the gateway's `mode`) which model and effort
 * serve the review and verify tasks. Each mode consumes a configurable number of credits.
 */
import { creditsEnv } from "@/lib/env";
import type { ReviewMode } from "./types";

export interface ModeProfile {
  /** Token budget for retrieved context (changed files' own content is not counted). */
  contextTokens: number;
  /** Separate cap for definitions of changed symbols (not charged to `contextTokens`), half the context budget. */
  definitionTokens: number;
  /** Most specialized agents that run (correctness included). */
  maxAgents: number;
  /** Depth of transitive-dependent traversal (0 = none). */
  dependentDepth: 0 | 1 | 2;
  /** Per-item cap so one huge symbol cannot eat the budget. */
  maxItemTokens: number;
  /** Rows taken from each retrieval source. */
  perSourceLimit: number;
  /** Changed files reviewed at most; the rest are reported as skipped. */
  maxFiles: number;
  /** Refine the heuristic classification with a cheap model call. */
  modelClassification: boolean;
  /** Candidates per verification-judge call. */
  judgeBatch: number;
}

export const MODE_PROFILES: Readonly<Record<ReviewMode, ModeProfile>> = {
  fast: {
    contextTokens: 12_000,
    definitionTokens: 6_000,
    maxAgents: 2,
    dependentDepth: 0,
    maxItemTokens: 1_500,
    perSourceLimit: 5,
    maxFiles: 30,
    modelClassification: false,
    judgeBatch: 6,
  },
  standard: {
    contextTokens: 40_000,
    definitionTokens: 20_000,
    maxAgents: 5,
    dependentDepth: 1,
    maxItemTokens: 3_000,
    perSourceLimit: 10,
    maxFiles: 60,
    modelClassification: true,
    judgeBatch: 6,
  },
  deep: {
    contextTokens: 100_000,
    definitionTokens: 50_000,
    maxAgents: Number.POSITIVE_INFINITY,
    dependentDepth: 2,
    maxItemTokens: 6_000,
    perSourceLimit: 20,
    maxFiles: 150,
    modelClassification: true,
    judgeBatch: 4,
  },
};

export function modeProfile(mode: ReviewMode): ModeProfile {
  return MODE_PROFILES[mode];
}

/** Credits a review in `mode` consumes (`CREDITS_FAST` / `CREDITS_STANDARD` / `CREDITS_DEEP`). */
export function creditsFor(mode: ReviewMode, source: Record<string, string | undefined> = process.env): number {
  const e = creditsEnv(source);
  return mode === "fast" ? e.CREDITS_FAST : mode === "deep" ? e.CREDITS_DEEP : e.CREDITS_STANDARD;
}
