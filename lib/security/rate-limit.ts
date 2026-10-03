/**
 * Rate limits for public, unauthenticated endpoints (R6.20): GitHub sign-in start and callback, SSO lookup, start,
 * callback and ACS, dev login, and invitation acceptance, counted per client address and endpoint in a one-minute
 * window (PUBLIC_RATE_LIMIT_PER_MINUTE). Uses the REST API's limiter (Redis in production, shared by every web
 * process; in memory in tests). Over the limit the endpoint answers 429 with `retry-after`.
 */
import { RedisRateLimiter, type RateLimitDecision, type RateLimiter } from "@/lib/api/rate-limit";
import { enterpriseEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { redis } from "@/lib/redis";

export const WINDOW_MS = 60_000;

let shared: RateLimiter | undefined;

/** The process-wide limiter for public endpoints (Redis-backed). */
export function publicLimiter(): RateLimiter {
  shared ??= new RedisRateLimiter(redis, log.child({ component: "rate-limit" }));
  return shared;
}

/**
 * The client address used as the rate-limit key: the last `X-Forwarded-For` hop (the one the nearest proxy appended;
 * earlier hops are client-controlled), else `X-Real-IP`, else "unknown" (all direct clients share one bucket).
 */
export function clientAddress(req: Request): string {
  const hops = req.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean);
  const last = hops?.[hops.length - 1];
  return (last || req.headers.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}

export function retryAfterSeconds(decision: RateLimitDecision, now: Date): number {
  return Math.max(1, Math.ceil((decision.resetAt.getTime() - now.getTime()) / 1000));
}

export function tooManyRequests(decision: RateLimitDecision, now: Date): Response {
  return new Response(
    "Too many requests. Wait a minute and try again.",
    {
      status: 429,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": String(retryAfterSeconds(decision, now)),
        "x-ratelimit-limit": String(decision.limit),
        "x-ratelimit-remaining": "0",
        "cache-control": "no-store",
      },
    },
  );
}

export interface PublicLimitOptions {
  limiter?: RateLimiter;
  /** Requests per minute; defaults to PUBLIC_RATE_LIMIT_PER_MINUTE. */
  limit?: number;
  now?: Date;
}

/** Counts one request to `bucket` from `key`; returns the 429 response when over the limit, else null. */
export async function checkRateLimit(bucket: string, key: string, opts: PublicLimitOptions = {}): Promise<Response | null> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? enterpriseEnv().PUBLIC_RATE_LIMIT_PER_MINUTE;
  const decision = await (opts.limiter ?? publicLimiter()).hit(`public:${bucket}:${key}`, limit, WINDOW_MS, now);
  return decision.allowed ? null : tooManyRequests(decision, now);
}

/**
 * Wraps a route handler so each client address may call it at most `limit` times a minute. `options` is read per
 * request, so tests (and route files) can inject the limiter and limit.
 */
export function withRateLimit<A extends unknown[]>(
  bucket: string,
  handler: (req: Request, ...rest: A) => Promise<Response>,
  options: () => PublicLimitOptions = () => ({}),
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    const limited = await checkRateLimit(bucket, clientAddress(req), options());
    return limited ?? handler(req, ...rest);
  };
}
