/**
 * Per-principal rate limiting for the REST API (R6.18): a fixed one-minute window per API key (or signed-in user).
 * Production counts in Redis so every web process shares the window; tests use {@link MemoryRateLimiter}.
 */
import type { Redis } from "ioredis";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";

const REDIS_TIMEOUT_MS = 1_000;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window (0 when over the limit). */
  remaining: number;
  /** When the current window ends. */
  resetAt: Date;
}

export interface RateLimiter {
  /** Counts one request for `key` in the window containing `now` and says whether it is within `limit`. */
  hit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitDecision>;
}

function windowOf(now: Date, windowMs: number) {
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  return { start, resetAt: new Date(start + windowMs) };
}

function decide(count: number, limit: number, resetAt: Date): RateLimitDecision {
  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt };
}

/** In-process limiter for tests and single-process tools. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();

  async hit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitDecision> {
    const { start, resetAt } = windowOf(now, windowMs);
    const k = `${key}:${start}`;
    const count = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, count);
    for (const old of this.counts.keys()) if (!old.endsWith(`:${start}`)) this.counts.delete(old);
    return decide(count, limit, resetAt);
  }
}

/**
 * Redis fixed-window limiter: `INCR` the window's counter and let it expire with the window. If Redis is unreachable
 * the request is allowed (and a warning logged): the API stays available, and Redis being down already stops the
 * job queue, which bounds what API calls can do.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: () => Redis,
    private readonly log: Logger = rootLog,
  ) {}

  async hit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitDecision> {
    const { start, resetAt } = windowOf(now, windowMs);
    const k = `openreview:ratelimit:${key}:${start}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The shared client queues commands while disconnected; never let a request wait on that.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("rate limiter timed out")), REDIS_TIMEOUT_MS);
      });
      const results = await Promise.race([this.redis().multi().incr(k).pexpire(k, windowMs + 1_000).exec(), timeout]);
      const count = Number(results?.[0]?.[1] ?? 0);
      return decide(count, limit, resetAt);
    } catch (err) {
      this.log.warn("API rate limiter unavailable; allowing the request", { key, error: errorMessage(err) });
      return { allowed: true, limit, remaining: limit, resetAt };
    } finally {
      clearTimeout(timer);
    }
  }
}
