/**
 * Repository knowledge base (R6.12): deterministic subsystem discovery (`discover.ts`), generation through the model
 * gateway (`generate.ts`), incremental refresh after indexing (`refresh.ts`), and retrieval of entries for the files
 * a review or question touches (`knowledgeForPaths`).
 */
export { clusterSubsystems, discoverSubsystems, KIND_TITLES, MAX_SUBSYSTEMS, type DiscoveryInput, type Subsystem } from "./discover";
export { generateEntry, knowledgeOutputSchema, type GeneratedEntry } from "./generate";
export { KnownPaths, UNKNOWN_FILE } from "./paths";
export {
  afterIndexCompleted,
  KnowledgeBusyError,
  llmUnavailableReason,
  queueKnowledgeRefresh,
  refreshKnowledge,
  type KnowledgeDeps,
  type KnowledgeEntry,
  type KnowledgeRun,
  type KnowledgeRunResult,
} from "./refresh";

export { knowledgeForPaths, type KnowledgeForPath } from "./retrieve";
