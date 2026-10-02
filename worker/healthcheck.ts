/**
 * Docker healthcheck for the worker container (R6.21): exits 0 only if this host's worker wrote a fresh heartbeat.
 * Run with `node_modules/.bin/tsx worker/healthcheck.ts`. Needs only REDIS_URL.
 */
import { hostname } from "node:os";
import { Redis } from "ioredis";
import { z } from "zod";
import { readWorkerHeartbeat } from "@/lib/jobs/heartbeat";
import { redactText } from "@/lib/log";

const TIMEOUT_MS = 5_000;

async function main(): Promise<number> {
  const url = z.string().url().parse(process.env.REDIS_URL);
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: TIMEOUT_MS,
    retryStrategy: () => null,
  });
  // Connection errors surface through `connect()`; keep the most specific one for the message.
  let lastError: Error | undefined;
  client.on("error", (err: Error) => {
    lastError = err;
  });
  try {
    await client.connect().catch((err: unknown) => {
      throw lastError ?? err;
    });
    const beat = await readWorkerHeartbeat(client, { host: hostname() });
    const age = beat.ageMs === undefined ? "" : ` (${Math.round(beat.ageMs / 1000)}s ago, ${beat.heartbeat?.active ?? 0} active)`;
    process.stdout.write(`worker heartbeat ${beat.status}${age}\n`);
    return beat.status === "ok" ? 0 : 1;
  } finally {
    client.disconnect();
  }
}

const timeout = new Promise<number>((resolve) =>
  setTimeout(() => {
    process.stdout.write("worker heartbeat check timed out\n");
    resolve(1);
  }, TIMEOUT_MS + 1_000),
);

Promise.race([main(), timeout])
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stdout.write(`worker heartbeat check failed: ${redactText(err instanceof Error ? err.message : String(err))}\n`);
    process.exit(1);
  });
