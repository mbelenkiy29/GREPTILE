import { Queue } from "bullmq";
import { log } from "@/lib/log";
import { redis } from "@/lib/redis";
import { JOB_PRIORITY, type JobName, type JobOptions, type JobPayloads, type JobQueue } from "./types";

export const QUEUE_NAME = "openreview";

let queue: Queue | undefined;

function bull() {
  queue ??= new Queue(QUEUE_NAME, {
    connection: redis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return queue;
}

/** BullMQ-backed queue. Every job gets a priority (mentions > reviews > indexing) so ordering is consistent. */
export const bullQueue: JobQueue = {
  async add<N extends JobName>(name: N, data: JobPayloads[N], opts: JobOptions) {
    const priority = opts.priority ?? JOB_PRIORITY[name];
    await bull().add(name, data, { jobId: opts.jobId, priority, ...(opts.delay ? { delay: opts.delay } : {}) });
    log.debug("job enqueued", {
      job: name,
      jobId: opts.jobId,
      priority,
      orgId: data.orgId,
      repoId: data.repoId,
      deliveryId: data.meta?.deliveryId,
    });
  },
};

/** Adds a job to the shared queue. `jobId` must be deterministic so retries and redeliveries do not duplicate work. */
export function enqueue<N extends JobName>(name: N, data: JobPayloads[N], opts: JobOptions): Promise<void> {
  return bullQueue.add(name, data, opts);
}
