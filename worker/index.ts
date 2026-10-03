/**
 * Background worker: consumes the BullMQ queue (indexing, reviews, mention
 * answers). Run with `pnpm worker`; in Docker Compose it is the `worker` service.
 */
import { hostname } from "node:os";
import { DelayedError, Worker } from "bullmq";
import { pruneDeliveries } from "@/lib/data/deliveries";
import { purgeDemoData } from "@/lib/demo/purge";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { gitHost } from "@/lib/git/host";
import { retryAfterMs, runObservedJob, type JobDeps } from "@/lib/jobs/handlers";
import { startHeartbeat } from "@/lib/jobs/heartbeat";
import { deferIfRateLimited } from "@/lib/jobs/rate-limit";
import { QUEUE_NAME, bullQueue, scheduleRepeatingJob } from "@/lib/jobs/queue";
import { embeddings, llm } from "@/lib/llm";
import { errorMessage, log, redactText } from "@/lib/log";
import { RECOVERY_INTERVAL_MS, recoverStaleRuns } from "@/lib/pipeline/recovery";
import { redis } from "@/lib/redis";
import { sandboxFromEnv } from "@/lib/sandbox/validate";

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
  llm: llm({ db: db() }),
  embedder: embeddings({ db: db() }),
  cacheDir: e.REPO_CACHE_DIR,
  botMention: e.BOT_MENTION,
  sandbox: sandboxFromEnv(e.REPO_CACHE_DIR, wlog),
};

let active = 0;
const worker = new Worker(
  QUEUE_NAME,
  async (job, token) => {
    active++;
    try {
      return await runObservedJob(deps, { name: job.name, id: job.id, data: job.data, attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 }, wlog);
    } catch (err) {
      // A GitHub rate limit that resets minutes from now: wait for the reset rather than spend the retries.
      if (await deferIfRateLimited(job, token, err, { log: wlog })) throw new DelayedError();
      // Contention (e.g. a repository's index lock) delays the job instead of spending one of its attempts.
      const delay = retryAfterMs(err);
      if (delay !== null && token) {
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }
      throw err;
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
  // Demo retention (R3.7): results and demo indexes older than DEMO_RETENTION_HOURS.
  try {
    const purged = await purgeDemoData(deps.db, { retentionHours: e.DEMO_RETENTION_HOURS, cacheDir: e.REPO_CACHE_DIR });
    if (purged.reviews || purged.repos) wlog.info("purged demo data", { ...purged, retentionHours: e.DEMO_RETENTION_HOURS });
  } catch (err) {
    wlog.warn("purging demo data failed", { error: errorMessage(err) });
  }
}
void prune();
const pruneTimer = setInterval(() => void prune(), 3_600_000);
pruneTimer.unref();

/** Restart recovery (R6.6): re-queue review runs abandoned by a crashed worker, on start and every 5 minutes. */
async function recover() {
  try {
    await recoverStaleRuns({ db: deps.db, queue: deps.queue, log: wlog });
  } catch (err) {
    wlog.warn("review run recovery failed", { error: errorMessage(err) });
  }
}
void recover();
const recoveryTimer = setInterval(() => void recover(), RECOVERY_INTERVAL_MS);
recoveryTimer.unref();

/** Usage sweep (R4.2, R4.3): seat sync, overage reporting, and usage alerts, hourly as one queued job across workers. */
scheduleRepeatingJob("report-usage", 3_600_000, {}).catch((err) => wlog.warn("could not schedule the usage report job", { error: errorMessage(err) }));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  wlog.info("worker shutting down", { signal, active });
  clearInterval(pruneTimer);
  clearInterval(recoveryTimer);
  // Drain active jobs first so the heartbeat (and the container healthcheck) stays truthful meanwhile.
  await worker.close();
  await heartbeat.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
wlog.info("worker listening", { queue: QUEUE_NAME, concurrency: e.WORKER_CONCURRENCY });
