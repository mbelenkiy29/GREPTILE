import type { ReviewMode } from "@/lib/llm/types";
import type { DependencyChange } from "./signals";

/** Where a context item came from (R6.5). */
export type ContextKind =
  | "definition"
  | "caller"
  | "callee"
  | "importer"
  | "dependent"
  | "test"
  | "route"
  | "schema_consumer"
  | "config"
  | "symbol_match"
  | "path_match"
  | "text_match"
  | "similar_code"
  | "doc"
  | "instructions"
  | "context_doc"
  | "recent_change"
  | "history"
  | "rule";

export interface ContextItem {
  kind: ContextKind;
  path: string;
  /** 1-based inclusive range; 0..0 for items that are not code at a location (rules, commits, history). */
  startLine: number;
  endLine: number;
  name: string | null;
  content: string;
  score: number;
  /** Every way this item was reached, e.g. "calls changed symbol computeTotal (services/billing/pricing.ts)". */
  reasons: string[];
  /** Estimated tokens of `content`. */
  tokens: number;
  /**
   * Not charged to the context budget (definitions of changed code, which is already in the diff). These have their
   * own cap, the mode's `definitionTokens`.
   */
  free?: boolean;
  /** "base" for code from the base commit (a symbol the PR removed); never merged with head-version code. */
  version?: "base";
}

/** A symbol the pull request adds, modifies, or removes, as parsed from the head (or base, when removed). */
export interface ChangedSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
  content: string;
  /** The indexed (base) symbol, when it exists in the index. */
  indexId: number | null;
  /** Signature at the base commit, when the symbol existed there. */
  baseSignature: string | null;
  change: "added" | "modified" | "removed";
  /** Names the symbol calls (head). */
  calls: string[];
}

export interface Flow {
  from: string;
  to: string;
  label: string;
}

export interface RelevantTest {
  path: string;
  note: string;
}

export interface ContextBundle {
  mode: ReviewMode;
  /** Items kept within the budget, highest score first. */
  items: ContextItem[];
  changed: ChangedSymbol[];
  /** Top-level components (first two directory levels) the change and its graph neighbors span. */
  components: string[];
  /** Cross-component call/import relations among changed and impacted code. */
  flows: Flow[];
  /** Tests covering changed code (from the index) and tests the PR itself changes. */
  tests: RelevantTest[];
  changedTests: string[];
  dependencyChanges: DependencyChange[];
  /** Changed exported symbols and how many places outside the changed files depend on them. */
  externalDependents: { symbol: string; path: string; dependents: string[] }[];
  tokensUsed: number;
  tokenBudget: number;
  dropped: number;
  droppedItems: ContextItem[];
}
