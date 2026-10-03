import { backoffDelay, isRetryable, type BackoffOptions } from "./retry";
import { addUsage, LlmAbortError, LlmError, LlmTimeoutError, ZERO_USAGE, type Usage } from "./types";

/**
 * Runs one attempt under a timeout. The attempt receives an AbortSignal that fires on timeout or when the caller
 * cancels; the attempt is also raced against that signal so a provider that ignores it cannot hang the call.
 */
export async function runAttempt<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number, caller?: AbortSignal): Promise<T> {
  if (caller?.aborted) throw new LlmAbortError("model call cancelled", { cause: caller.reason });
  const timeout = new AbortController();
  const signal = caller ? AbortSignal.any([caller, timeout.signal]) : timeout.signal;
  const reason = (cause?: unknown) =>
    caller?.aborted
      ? new LlmAbortError("model call cancelled", { cause })
      : new LlmTimeoutError(`model call timed out after ${timeoutMs}ms`, { cause });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  let attempt: Promise<T>;
  try {
    attempt = fn(signal);
  } catch (err) {
    attempt = Promise.reject(err);
  }
  // Whichever promise loses the race must not surface as an unhandled rejection.
  attempt.catch(() => undefined);
  aborted.catch(() => undefined);
  try {
    return await Promise.race([attempt, aborted]);
  } catch (err) {
    if (!signal.aborted) throw err;
    if (caller?.aborted) throw err instanceof LlmAbortError ? err : reason(err);
    throw err instanceof LlmTimeoutError ? err : reason(err);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Sleeps `ms` unless `signal` aborts first; returns false when cancelled (before or during the wait). */
export async function sleepUnlessAborted(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await sleep(ms);
    return true;
  }
  if (signal.aborted) return false;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const slept = sleep(ms).then(() => true as const);
    slept.catch(() => undefined);
    return (await Promise.race([slept, aborted])) && !signal.aborted;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export interface RetryPolicy {
  /** Retries after the first attempt for transient failures. */
  maxRetries: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  backoff?: BackoffOptions;
}

export type RetryOutcome<T> =
  | { ok: true; value: T; attempts: number; failedUsage: Usage }
  | { ok: false; error: unknown; attempts: number; failedUsage: Usage };

export interface RetryHooks {
  signal?: AbortSignal;
  /** Returns true to try again immediately (e.g. a corrective retry after invalid output); not counted as a retry. */
  corrective?: (err: unknown) => boolean;
  onRetry?: (err: LlmError, delayMs: number, attempt: number) => void;
}

/**
 * Attempts `fn` until it succeeds, fails permanently, or runs out of retries. Transient failures back off with full
 * jitter (honoring `retry-after`). Tokens consumed by failed attempts are summed into `failedUsage`.
 */
export async function withRetries<T>(
  fn: (signal: AbortSignal, attempt: number) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks = {},
): Promise<RetryOutcome<T>> {
  let attempts = 0;
  let retries = 0;
  let failedUsage = ZERO_USAGE;
  for (;;) {
    attempts++;
    const attempt = attempts;
    try {
      const value = await runAttempt((signal) => fn(signal, attempt), policy.timeoutMs, hooks.signal);
      return { ok: true, value, attempts, failedUsage };
    } catch (err) {
      if (err instanceof LlmError && err.usage) failedUsage = addUsage(failedUsage, err.usage);
      if (hooks.corrective?.(err)) continue;
      if (err instanceof LlmError && isRetryable(err) && retries < policy.maxRetries) {
        const delay = backoffDelay(retries, err.retryAfterMs, policy.backoff);
        retries++;
        hooks.onRetry?.(err, delay, attempt);
        // Cancellation ends a backoff wait at once (a retry-after can be up to two minutes).
        if (!(await sleepUnlessAborted(policy.sleep, delay, hooks.signal))) {
          return { ok: false, error: new LlmAbortError("model call cancelled", { cause: hooks.signal?.reason }), attempts, failedUsage };
        }
        continue;
      }
      return { ok: false, error: err, attempts, failedUsage };
    }
  }
}
