/** The CLI's HTTP client for an OpenReview server (REST API v1 and the login endpoints). */
import type { z } from "zod";
import pkg from "../package.json";
import { CliError, scrubSecrets } from "./errors";
import type { CliIo } from "./io";

export const CLI_VERSION: string = pkg.version;
const USER_AGENT = `openreview-cli/${CLI_VERSION}`;
const REQUEST_TIMEOUT_MS = 30_000;

/** An error the server answered with (`{ error: { code, message } }`). */
export class ApiResponseError extends CliError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    hint?: string,
  ) {
    super(message, hint);
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Defaults to 30s; reviews pass a longer one. */
  timeoutMs?: number;
  /** Plain-text response (fix prompts). */
  text?: boolean;
}

function describeNetworkError(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
}

export class ApiClient {
  constructor(
    private readonly io: CliIo,
    readonly server: string,
    private readonly token: string | null,
  ) {}

  private async send(method: string, path: string, opts: RequestOptions): Promise<Response> {
    const url = new URL(path, `${this.server}/`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: opts.text ? "text/plain, application/json" : "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const signal = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      return await this.io.fetch(url, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}), signal });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw new CliError(`The OpenReview server at ${this.server} did not answer within ${Math.round((opts.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)}s.`, "Try again, or run the review locally with --local.");
      }
      throw new CliError(
        `Can't reach the OpenReview server at ${this.server} (${scrubSecrets(describeNetworkError(err))}).`,
        "Check the URL (`openreview status`) and your network, or run the review locally with --local.",
      );
    }
  }

  private async fail(res: Response): Promise<never> {
    let code = "http_error";
    let message = `The server answered ${res.status} ${res.statusText}.`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } | string; error_description?: string };
      if (body.error && typeof body.error === "object") {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      } else if (typeof body.error === "string") {
        code = body.error;
        message = body.error_description ?? message;
      }
    } catch {
      // Not JSON (a proxy's error page): keep the status line.
    }
    message = scrubSecrets(message);
    if (res.status === 401) throw new ApiResponseError(401, code, `The server rejected your API key: ${message}`, "Run `openreview login` again.");
    if (res.status === 403 && code === "insufficient_scope") {
      throw new ApiResponseError(403, code, message, "Ask an admin for a role that allows it, or create a key with that scope under Settings → API keys.");
    }
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      throw new ApiResponseError(429, code, message, retry ? `Retry in ${retry}s.` : undefined);
    }
    throw new ApiResponseError(res.status, code, message);
  }

  /** Sends a request and validates the JSON response with `schema`. */
  async json<S extends z.ZodType>(method: string, path: string, schema: S, opts: RequestOptions = {}): Promise<z.infer<S>> {
    const res = await this.send(method, path, opts);
    if (!res.ok) return this.fail(res);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CliError(`${this.server} did not answer with JSON. Is it an OpenReview server?`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const at = parsed.error.issues[0]?.path.join(".") || "(root)";
      throw new CliError(`Unexpected response from ${this.server}${path} (at ${at}). The server may run a different OpenReview version than this CLI (${CLI_VERSION}).`);
    }
    return parsed.data;
  }

  async text(method: string, path: string, opts: RequestOptions = {}): Promise<string> {
    const res = await this.send(method, path, { ...opts, text: true });
    if (!res.ok) return this.fail(res);
    return res.text();
  }

  /** Raw response (the device-login poll reads error bodies itself). */
  async raw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    return this.send(method, path, opts);
  }
}
