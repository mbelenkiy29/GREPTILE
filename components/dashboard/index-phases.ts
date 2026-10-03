/** Readable names of the indexer's phases (R6.3); shared by server and client components. */
export const INDEX_PHASE_LABEL: Record<string, string> = {
  queued: "Waiting to start",
  checkout: "Checking out",
  scan: "Scanning files",
  parse: "Parsing",
  embed: "Embedding",
  graph: "Building graph",
  finalize: "Finalizing",
  done: "Done",
};
