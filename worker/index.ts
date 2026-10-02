/**
 * Background worker: consumes the BullMQ queue (indexing, reviews, mention
 * answers). Run with `pnpm worker`; in Docker Compose it is the `worker` service.
 */
import { hostname } from "node:os";
import { Worker } from "bullmq";
import { pruneDeliveries } from "@/lib/data/deliveries";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { gitHost } from "@/lib/git/host";
import { runObservedJob, type JobDeps } from "@/lib/jobs/handlers";
import { startHeartbeat } from "@/lib/jobs/heartbeat";
import { QUEUE_NAME, bullQueue } from "@/lib/jobs/queue";
import { embeddings, llm } from "@/lib/llm";
import { errorMessage, log, redactText } from "@/lib/log";
import { redis } from "@/lib/redis";

const wlog = log.child({ component: "worker", host: hostname(), pid: process.pid });

process.on("unhandledRejection", (reason) => {
  wlog.error("unhandled promise rejection", { error: errorMessage(reason) });
});
process.on("uncaughtException", (err) => {
  wlog.error("uncaught exception; exiting", { error: errorMessage(err), stack: err.stack ? redactText(err.stack) : undefined });
  process.exit(1);
});

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

let active = 0;
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    active++;
    try {
      return await runObservedJob(deps, { name: job.name, id: job.id, data: job.data, attemptsMade: job.attemptsMade }, wlog);
    } finally {
      active--;
    }
  },
  { connection: redis(), concurrency: e.WORKER_CONCURRENCY },
);

worker.on("error", (err) => wlog.error("worker error", { error: errorMessage(err) }));
worker.on("stalled", (jobId) => wlog.warn("job stalled; it will be retried", { jobId }));

const heartbeat = startHeartbeat(redis(), {
  host: hostname(),
  pid: process.pid,
  queue: QUEUE_NAME,
  concurrency: e.WORKER_CONCURRENCY,
  active: () => active,
  log: wlog,
});

/** Retention for webhook delivery records (R6.21), hourly. */
async function prune() {
  try {
    const removed = await pruneDeliveries(deps.db, new Date(Date.now() - e.WEBHOOK_DELIVERY_RETENTION_DAYS * 86_400_000));
    if (removed) wlog.info("pruned webhook deliveries", { removed, retentionDays: e.WEBHOOK_DELIVERY_RETENTION_DAYS });
  } catch (err) {
    wlog.warn("pruning webhook deliveries failed", { error: errorMessage(err) });
  }
}
void prune();
const pruneTimer = setInterval(() => void prune(), 3_600_000);
pruneTimer.unref();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  wlog.info("worker shutting down", { signal, active });
  clearInterval(pruneTimer);
  await heartbeat.stop();
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
wlog.info("worker listening", { queue: QUEUE_NAME, concurrency: e.WORKER_CONCURRENCY });
