import type { Db } from "@/lib/db";
import type { GitHost } from "@/lib/git/types";
import { indexRepo } from "@/lib/indexer";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import type { JobName, JobPayloads, JobQueue } from "./types";

export interface JobDeps {
  db: Db;
  host: GitHost;
  queue: JobQueue;
  llm: LlmProvider;
  embedder: EmbeddingProvider;
  cacheDir: string;
  botMention: string;
}

type Handlers = { [N in JobName]: (deps: JobDeps, data: JobPayloads[N]) => Promise<unknown> };

export const handlers: Handlers = {
  "index-repo": (deps, data) => indexRepo(deps, data),
  "review-pr": async () => {
    throw new Error("review-pr handler not registered");
  },
  "answer-mention": async () => {
    throw new Error("answer-mention handler not registered");
  },
};

export function runJob<N extends JobName>(deps: JobDeps, name: N, data: JobPayloads[N]) {
  const handler = handlers[name] as (deps: JobDeps, data: JobPayloads[N]) => Promise<unknown>;
  if (!handler) throw new Error(`unknown job ${name}`);
  return handler(deps, data);
}
