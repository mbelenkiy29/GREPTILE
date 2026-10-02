import { Queue } from "bullmq";
import { redis } from "@/lib/redis";
import type { JobName, JobPayloads, JobQueue } from "./types";

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

export const bullQueue: JobQueue = {
  async add<N extends JobName>(name: N, data: JobPayloads[N], opts: { jobId: string }) {
    await bull().add(name, data, { jobId: opts.jobId });
  },
};
