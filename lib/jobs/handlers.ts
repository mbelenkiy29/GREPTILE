import type { Db } from "@/lib/db";
import type { GitHost } from "@/lib/git/types";
import { indexRepo } from "@/lib/indexer";
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm";
import { syncFeedback } from "@/lib/learning";
import { mineRules } from "@/lib/learning/mining";
import { answerMention } from "@/lib/review/mention";
import { runReviewJob } from "@/lib/review/run";
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
  "review-pr": (deps, data) => runReviewJob(deps, data),
  "answer-mention": (deps, data) => answerMention(deps, data),
  "sync-feedback": (deps, data) => syncFeedback(deps, data),
  "mine-rules": (deps, data) => mineRules(deps, data),
};

export function runJob<N extends JobName>(deps: JobDeps, name: N, data: JobPayloads[N]) {
  const handler = handlers[name] as (deps: JobDeps, data: JobPayloads[N]) => Promise<unknown>;
  if (!handler) throw new Error(`unknown job ${name}`);
  return handler(deps, data);
}
