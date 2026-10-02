import { z } from "zod";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";

/**
 * Worker liveness (R6.21). Each worker writes a heartbeat every 15 s with a 60 s TTL, under a shared key (read by
 * `/api/health`: is any worker alive?) and a per-host key (read by the worker container's own healthcheck).
 */
export const HEARTBEAT_KEY = "openreview:worker:heartbeat";
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TTL_SECONDS = 60;
/** A heartbeat older than two missed beats is stale; after the TTL it is gone (missing). */
export const HEARTBEAT_STALE_MS = 2 * HEARTBEAT_INTERVAL_MS;

/** The two Redis commands the heartbeat needs (ioredis satisfies it; tests pass a fake). */
export interface HeartbeatStore {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

const heartbeatSchema = z.object({
  at: z.string(),
  host: z.string(),
  pid: z.number(),
  queue: z.string(),
  concurrency: z.number(),
  active: z.number(),
  startedAt: z.string(),
});
export type WorkerHeartbeat = z.infer<typeof heartbeatSchema>;

export type WorkerStatus = "ok" | "stale" | "missing";

export function heartbeatKey(host?: string) {
  return host ? `${HEARTBEAT_KEY}:${host}` : HEARTBEAT_KEY;
}

export async function writeHeartbeat(store: HeartbeatStore, beat: WorkerHeartbeat) {
  const value = JSON.stringify(beat);
  await Promise.all([
    store.set(heartbeatKey(), value, "EX", HEARTBEAT_TTL_SECONDS),
    store.set(heartbeatKey(beat.host), value, "EX", HEARTBEAT_TTL_SECONDS),
  ]);
}

/** Reads the newest heartbeat (any worker, or one host's) and classifies it as ok, stale, or missing. */
export async function readWorkerHeartbeat(
  store: Pick<HeartbeatStore, "get">,
  opts: { host?: string; now?: number } = {},
): Promise<{ status: WorkerStatus; ageMs?: number; heartbeat?: WorkerHeartbeat }> {
  const raw = await store.get(heartbeatKey(opts.host));
  if (!raw) return { status: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "missing" };
  }
  const beat = heartbeatSchema.safeParse(parsed);
  if (!beat.success) return { status: "missing" };
  const ageMs = Math.max(0, (opts.now ?? Date.now()) - Date.parse(beat.data.at));
  return { status: ageMs > HEARTBEAT_STALE_MS ? "stale" : "ok", ageMs, heartbeat: beat.data };
}

export interface HeartbeatOptions {
  host: string;
  pid: number;
  queue: string;
  concurrency: number;
  /** Jobs currently running in this worker. */
  active: () => number;
  intervalMs?: number;
  now?: () => number;
  log?: Logger;
}

/**
 * Writes a heartbeat now and every `intervalMs`. Write failures are logged and retried on the next beat. `stop()`
 * clears the timer and removes this host's key (the shared key expires on its own if no other worker is alive).
 */
export function startHeartbeat(store: HeartbeatStore, opts: HeartbeatOptions) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? rootLog.child({ component: "worker" });
  const startedAt = new Date(now()).toISOString();
  let failing = false;

  const beat = async () => {
    try {
      await writeHeartbeat(store, {
        at: new Date(now()).toISOString(),
        host: opts.host,
        pid: opts.pid,
        queue: opts.queue,
        concurrency: opts.concurrency,
        active: opts.active(),
        startedAt,
      });
      if (failing) log.info("worker heartbeat restored");
      failing = false;
    } catch (err) {
      if (!failing) log.warn("worker heartbeat write failed", { error: errorMessage(err) });
      failing = true;
    }
  };

  const first = beat();
  const timer = setInterval(() => void beat(), opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    /** Resolves after the first heartbeat attempt. */
    ready: first,
    beat,
    async stop() {
      clearInterval(timer);
      await store.del(heartbeatKey(opts.host)).catch(() => undefined);
    },
  };
}
