import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { readWorkerHeartbeat, type WorkerStatus } from "@/lib/jobs/heartbeat";
import { redactText } from "@/lib/log";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function check(what: string, fn: () => Promise<unknown>): Promise<"ok" | string> {
  try {
    await withTimeout(fn(), what);
    return "ok";
  } catch (err) {
    return err instanceof Error ? redactText(err.message) : "error";
  }
}

/**
 * Liveness for the app container: Postgres and Redis must answer. `worker` reports the newest worker heartbeat
 * (R6.21) for information only; a stopped worker does not make the app unhealthy.
 */
export async function GET() {
  const [database, cache, worker] = await Promise.all([
    check("database", () => sql()`select 1`),
    check("redis", () => redis().ping()),
    withTimeout(readWorkerHeartbeat(redis()), "worker heartbeat")
      .then((h): WorkerStatus => h.status)
      .catch((): WorkerStatus => "missing"),
  ]);
  const healthy = database === "ok" && cache === "ok";
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", database, redis: cache, worker },
    { status: healthy ? 200 : 503 },
  );
}
