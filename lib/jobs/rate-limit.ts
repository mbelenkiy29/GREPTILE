import { GitHubError } from "@/lib/github/client";
import { errorMessage, type Logger } from "@/lib/log";

/** A job that hits a rate limit is put back at most this many times (counting every start), then fails normally. */
export const MAX_RATE_LIMIT_DEFERRALS = 8;
/** Margin added after the reported reset so the retry does not land a moment too early. */
const RESET_MARGIN_MS = 1_000;

/**
 * How long to wait before retrying after `err`, when it is (or wraps) a GitHub rate-limit failure whose reset is too far
 * away for the client to wait in-process. Undefined for every other error.
 */
export function rateLimitRetryMs(err: unknown): number | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof GitHubError && e.retryAfterMs !== undefined) return e.retryAfterMs;
  }
  return undefined;
}

/** The slice of a BullMQ job this needs (kept structural so it can be tested without Redis). */
export interface DeferrableJob {
  id?: string;
  name: string;
  attemptsStarted: number;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

/**
 * Moves a rate-limited job back to the delayed set until GitHub's reset, instead of burning its retries (which back
 * off over seconds) against a limit that lasts minutes. Returns true when the job was deferred; the caller must then
 * throw BullMQ's `DelayedError` so the worker leaves it delayed. Deferring does not count as a failed attempt.
 */
export async function deferIfRateLimited(
  job: DeferrableJob,
  token: string | undefined,
  err: unknown,
  opts: { now?: () => number; log?: Logger } = {},
): Promise<boolean> {
  const retryMs = rateLimitRetryMs(err);
  if (retryMs === undefined || job.attemptsStarted > MAX_RATE_LIMIT_DEFERRALS) return false;
  const until = (opts.now ?? Date.now)() + retryMs + RESET_MARGIN_MS;
  await job.moveToDelayed(until, token);
  opts.log?.warn("job rate-limited by GitHub; delayed until the limit resets", {
    jobId: job.id,
    job: job.name,
    delayMs: retryMs + RESET_MARGIN_MS,
    attemptsStarted: job.attemptsStarted,
    error: errorMessage(err),
  });
  return true;
}
