import { createApiKey, type ApiScope } from "@/lib/api/keys";
import { MemoryRateLimiter } from "@/lib/api/rate-limit";
import { executeRoute, type ApiDeps } from "@/lib/api/router";
import { V1_ROUTES } from "@/lib/api/v1";
import type { Db } from "@/lib/db";
import { MemoryQueue } from "@/lib/jobs/types";

export const API_ORIGIN = "https://review.example.com";

/** REST API dependencies for tests: in-memory queue and rate limiter, a fixed clock, no git host. */
export function apiDeps(db: Db, overrides: Partial<ApiDeps> = {}): ApiDeps & { queue: MemoryQueue } {
  const queue = (overrides.queue as MemoryQueue | undefined) ?? new MemoryQueue();
  return {
    db,
    now: () => new Date("2026-03-01T12:00:00Z"),
    limiter: new MemoryRateLimiter(),
    rateLimitPerMinute: 1000,
    appUrl: API_ORIGIN,
    sessionTtlDays: 30,
    ...overrides,
    queue,
  };
}

export async function makeKey(db: Db, orgId: string, scopes: ApiScope[], extra: { expiresInDays?: number | null; now?: Date } = {}) {
  return createApiKey(db, { orgId, createdBy: null, name: `test key (${scopes.length} scopes)`, scopes, expiresInDays: extra.expiresInDays ?? null, now: extra.now });
}

export interface CallOptions {
  token?: string;
  cookie?: string;
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

/** Calls the v1 API the way Next.js would: matches `METHOD /path?query` against the route table. */
export async function call(deps: ApiDeps, request: string, opts: CallOptions = {}): Promise<Response> {
  const [method, target] = request.split(" ") as [string, string];
  const url = new URL(`/api/v1${target}`, API_ORIGIN);
  const path = url.pathname.slice("/api/v1".length);
  for (const route of V1_ROUTES) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const re = new RegExp(`^${route.path.replace(/\./g, "\\.").replace(/\{(\w+)\}/g, (_, n: string) => (names.push(n), "([^/]+)"))}$`);
    const m = re.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
    const headers = new Headers(opts.headers);
    if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
    if (opts.cookie) headers.set("cookie", opts.cookie);
    if (opts.origin) headers.set("origin", opts.origin);
    let body: string | undefined = opts.rawBody;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    return executeRoute(route, deps, new Request(url, { method, headers, ...(body !== undefined ? { body } : {}) }), params);
  }
  throw new Error(`no route for ${request}`);
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
