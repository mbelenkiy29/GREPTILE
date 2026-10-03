/**
 * Binds REST API v1 routes (lib/api/v1.ts) to Next.js route handlers with the production dependencies: Postgres,
 * the BullMQ queue, the Redis rate limiter, the GitHub host for reading current code in fix prompts, and the
 * embedding model for codebase search. The MCP endpoint (`lib/mcp/http.ts`) uses the same dependencies.
 */
import { db } from "@/lib/db";
import { apiEnv, authEnv } from "@/lib/env";
import { clientFor, gitHost } from "@/lib/git/host";
import { bullQueue } from "@/lib/jobs/queue";
import { embeddings, llm, type EmbeddingProvider } from "@/lib/llm";
import { errorMessage, log } from "@/lib/log";
import { redis } from "@/lib/redis";
import { RedisRateLimiter } from "./rate-limit";
import { executeRoute, routeId, type ApiDeps } from "./router";
import { V1_ROUTES } from "./v1";

let limiter: RedisRateLimiter | undefined;
let embedder: EmbeddingProvider | null | undefined;

/** The env-configured embedding model, or none (search then skips semantic matches) when it is misconfigured. */
function searchEmbedder(): EmbeddingProvider | undefined {
  if (embedder === undefined) {
    try {
      embedder = embeddings({ db: db() });
    } catch (err) {
      log.child({ component: "api" }).warn("embedding model unavailable; codebase search uses symbols, paths, and full text only", { error: errorMessage(err) });
      embedder = null;
    }
  }
  return embedder ?? undefined;
}

export function productionApiDeps(): ApiDeps {
  const e = apiEnv();
  const apiLog = log.child({ component: "api" });
  limiter ??= new RedisRateLimiter(redis, apiLog);
  const emb = searchEmbedder();
  return {
    db: db(),
    queue: bullQueue,
    now: () => new Date(),
    limiter,
    rateLimitPerMinute: e.API_RATE_LIMIT_PER_MINUTE,
    appUrl: e.APP_URL,
    sessionTtlDays: authEnv().SESSION_TTL_DAYS,
    readFile: ({ provider, installationExternalId, repoFullName, path, ref }) =>
      clientFor(gitHost(), { provider, externalId: installationExternalId }).getFileContent(repoFullName, path, ref),
    ...(emb ? { embedder: emb } : {}),
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
    // Routes without dynamic segments get no params object.
    const raw = (await ctx?.params) ?? {};
    const params: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(raw)) if (v !== undefined) params[k] = v;
    return executeRoute(route, productionApiDeps(), req, params);
  };
}
