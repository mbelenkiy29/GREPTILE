/**
 * Background worker: consumes the BullMQ queue (indexing, reviews, mention
 * answers). Run with `pnpm worker`; in Docker Compose it is the `worker` service.
 */
import { Worker } from "bullmq";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { gitHost } from "@/lib/git/host";
import { runJob, type JobDeps } from "@/lib/jobs/handlers";
import { QUEUE_NAME, bullQueue } from "@/lib/jobs/queue";
import type { JobName } from "@/lib/jobs/types";
import { embeddings, llm } from "@/lib/llm";
import { redis } from "@/lib/redis";

const e = env();
const deps: JobDeps = {
  db: db(),
  host: gitHost(),
  queue: bullQueue,
  llm: llm(),
  embedder: embeddings(),
  cacheDir: e.REPO_CACHE_DIR,
  botMention: e.BOT_MENTION,
};

const worker = new Worker(
  QUEUE_NAME,
  async (job) => runJob(deps, job.name as JobName, job.data),
  { connection: redis(), concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) },
);

worker.on("completed", (job) => console.log(`[worker] ${job.name} ${job.id} completed`));
worker.on("failed", (job, err) => console.error(`[worker] ${job?.name} ${job?.id} failed: ${err.message}`));

async function shutdown() {
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log(`[worker] listening on queue "${QUEUE_NAME}"`);
