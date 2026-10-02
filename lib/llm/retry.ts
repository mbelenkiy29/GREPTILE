import { redactText } from "@/lib/log";
import { LlmError } from "./types";

/**
 * Retry policy for model calls (R6.15): exponential backoff with full jitter, honoring `retry-after`.
 * Transient failures (408/409/429/5xx/529, network errors, timeouts) are retried; client errors
 * (400/401/403/404/422), refusals, and cancellations are not.
 */

export interface BackoffOptions {
  /** First retry's maximum delay. */
  baseMs?: number;
  /** Ceiling of the exponential window. */
  maxMs?: number;
  /** Longest server-requested wait we honor; longer requests are capped. */
  maxRetryAfterMs?: number;
  /** Uniform [0, 1) source; injected by tests. */
  random?: () => number;
}

export const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 30_000, maxRetryAfterMs: 120_000 } as const;

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function isRetryable(err: unknown): boolean {
  return err instanceof LlmError && err.retryable;
}

/** Delay before retry number `retry` (0-based): full jitter over `min(maxMs, baseMs * 2^retry)`, at least `retry-after`. */
export function backoffDelay(retry: number, retryAfterMs: number | undefined, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const maxMs = opts.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? DEFAULT_BACKOFF.maxRetryAfterMs;
  const random = opts.random ?? Math.random;
  const window = Math.min(maxMs, baseMs * 2 ** retry);
  const jitter = Math.floor(random() * window);
  if (retryAfterMs === undefined) return jitter;
  return Math.min(Math.max(retryAfterMs, jitter), maxRetryAfterMs);
}

type HeaderSource = Headers | Record<string, string | null | undefined> | null | undefined;

function header(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | null | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  return key ? (record[key] ?? undefined) : undefined;
}

/** Server-requested wait from `retry-after-ms`, or `retry-after` (seconds or an HTTP date). */
export function parseRetryAfter(headers: HeaderSource, now: number = Date.now()): number | undefined {
  const ms = header(headers, "retry-after-ms");
  if (ms !== undefined && ms.trim() !== "" && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const value = header(headers, "retry-after");
  if (value === undefined || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** An LlmError for a failed HTTP response, classified for retry. */
export function httpError(what: string, status: number, body: string, headers?: HeaderSource): LlmError {
  return new LlmError(`${what} failed: ${status} ${redactText(body).slice(0, 1000)}`, {
    status,
    retryable: isRetryableStatus(status),
    retryAfterMs: parseRetryAfter(headers),
  });
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
