/**
 * Shared REST transport for the token-based git hosts (GitLab, Bitbucket Cloud; R3.6): JSON requests with retries on
 * 502/503/504 and network errors (idempotent requests only), rate-limit waits (429 with `Retry-After` /
 * `RateLimit-Reset`) up to a cap, and failures as {@link ScmHttpError}. Credentials never appear in logs: only the
 * method, the URL path (no query string), the status, and timings are logged.
 */
import { log as rootLog, type Logger } from "@/lib/log";

export class ScmHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    /** Set when the host rate-limited the request: how long to wait before trying again. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ScmHttpError";
  }
}

/** Attempts per request, including the first. */
export const SCM_MAX_ATTEMPTS = 3;
/** Longest single wait for a rate limit or retry backoff before failing fast with `retryAfterMs`. */
export const SCM_MAX_WAIT_MS = 60_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ScmHttpOptions {
  provider: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: Logger;
  maxWaitMs?: number;
}

export interface ScmRequest {
  method?: string;
  /** JSON body. */
  body?: unknown;
  /** `Authorization` (or other auth) headers. */
  headers: Record<string, string>;
  accept?: string;
  /** Safe to retry after a 5xx or network error. Defaults to true for every method except POST. */
  idempotent?: boolean;
  /** Redirect handling; defaults to `error` so credentials are never sent on to another URL. */
  redirect?: "error" | "follow";
}

/** Wait before retrying a rate-limited response, from `Retry-After` or `RateLimit-Reset` (epoch seconds). */
export function scmRateLimitWaitMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = Number(headers.get("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now) + 1000;
  return undefined;
}

export class ScmHttp {
  readonly provider: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly maxWaitMs: number;

  constructor(opts: ScmHttpOptions) {
    this.provider = opts.provider;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? rootLog.child({ component: opts.provider });
    this.maxWaitMs = opts.maxWaitMs ?? SCM_MAX_WAIT_MS;
  }

  /** Sends one request with retries; resolves with the successful response, throws {@link ScmHttpError} otherwise. */
  async send(url: string, init: ScmRequest): Promise<Response> {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const idempotent = init.idempotent ?? method !== "POST";
    let attempt = 0;
    for (;;) {
      attempt++;
      const started = performance.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            accept: init.accept ?? "application/json",
            "user-agent": "openreview",
            ...init.headers,
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          redirect: init.redirect ?? "error",
        });
      } catch (err) {
        const durationMs = Math.round(performance.now() - started);
        const waitMs = 1000 * 2 ** (attempt - 1);
        const error = err instanceof Error ? err.message : String(err);
        if (idempotent && attempt < SCM_MAX_ATTEMPTS && waitMs <= this.maxWaitMs) {
          this.log.warn(`${this.provider} request failed; retrying`, { method, path, attempt, durationMs, waitMs, error });
          await this.sleep(waitMs);
          continue;
        }
        this.log.error(`${this.provider} request failed`, { method, path, attempt, durationMs, error });
        throw new ScmHttpError(this.provider, 0, `${this.provider} ${method} ${path} failed: ${error}`);
      }
      const durationMs = Math.round(performance.now() - started);
      const fields = { method, path, status: res.status, durationMs, attempt };
      if (res.ok) {
        this.log.debug(`${this.provider} request`, fields);
        return res;
      }
      const text = await res.text().catch(() => "");
      const rateLimited = res.status === 429;
      let waitMs: number | undefined;
      if (rateLimited) waitMs = scmRateLimitWaitMs(res.headers, this.now()) ?? SCM_MAX_WAIT_MS;
      else if (RETRYABLE_STATUS.has(res.status) && idempotent) waitMs = 1000 * 2 ** (attempt - 1);
      if (waitMs !== undefined && waitMs <= this.maxWaitMs && attempt < SCM_MAX_ATTEMPTS) {
        this.log.warn(rateLimited ? `${this.provider} rate limit hit; waiting before retry` : `${this.provider} server error; retrying`, { ...fields, waitMs });
        await this.sleep(waitMs);
        continue;
      }
      (res.status === 404 ? this.log.debug : this.log.info)(`${this.provider} request failed`, fields);
      throw new ScmHttpError(this.provider, res.status, `${this.provider} ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`, rateLimited ? waitMs : undefined);
    }
  }

  /** JSON request; a 204 resolves to undefined. */
  async json<T = unknown>(url: string, init: ScmRequest): Promise<T> {
    const res = await this.send(url, init);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** True for a 404 from the host (a missing file, ref, or object). */
export function isNotFound(err: unknown): boolean {
  return err instanceof ScmHttpError && err.status === 404;
}
