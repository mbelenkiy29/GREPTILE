/**
 * Binds REST API v1 routes (lib/api/v1.ts) to Next.js route handlers with the production dependencies: Postgres,
 * the BullMQ queue, the Redis rate limiter, and the GitHub host for reading current code in fix prompts.
 */
import { db } from "@/lib/db";
import { apiEnv, authEnv } from "@/lib/env";
import { gitHost } from "@/lib/git/host";
import { bullQueue } from "@/lib/jobs/queue";
import { embeddings, llm } from "@/lib/llm";
import { log } from "@/lib/log";
import { redis } from "@/lib/redis";
import { RedisRateLimiter } from "./rate-limit";
import { executeRoute, routeId, type ApiDeps } from "./router";
import { V1_ROUTES } from "./v1";

let limiter: RedisRateLimiter | undefined;

function productionDeps(): ApiDeps {
  const e = apiEnv();
  const apiLog = log.child({ component: "api" });
  limiter ??= new RedisRateLimiter(redis, apiLog);
  return {
    db: db(),
    queue: bullQueue,
    now: () => new Date(),
    limiter,
    rateLimitPerMinute: e.API_RATE_LIMIT_PER_MINUTE,
    appUrl: e.APP_URL,
    sessionTtlDays: authEnv().SESSION_TTL_DAYS,
    readFile: ({ installationExternalId, repoFullName, path, ref }) => gitHost().client(installationExternalId).getFileContent(repoFullName, path, ref),
    // The same model gateway and embedder the worker reviews pull requests with.
    reviewEngine: () => ({ llm: llm({ db: db() }), embedder: embeddings({ db: db() }) }),
    localReviewTimeoutMs: e.LOCAL_REVIEW_TIMEOUT_MS,
    log: apiLog,
  };
}

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

/** A Next.js route handler for the v1 route `"<METHOD> <path>"` (throws at import time for an unknown id). */
export function v1(id: string) {
  const route = V1_ROUTES.find((r) => routeId(r) === id);
  if (!route) throw new Error(`unknown API route ${id}`);
  return async (req: Request, ctx: RouteContext): Promise<Response> => {
    const raw = await ctx.params;
    const params: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(raw)) if (v !== undefined) params[k] = v;
    return executeRoute(route, productionDeps(), req, params);
  };
}
