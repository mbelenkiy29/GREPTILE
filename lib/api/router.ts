/**
 * The REST API's request pipeline (R6.18). Every `/api/v1` route is a {@link RouteSpec} in the route table
 * (`lib/api/v1.ts`); {@link executeRoute} runs one against a `Request`:
 *
 * 1. authenticate (API key, or session cookie + same-origin check for mutations), unless the route is public;
 * 2. rate-limit the principal (fixed window per minute; 429 with `retry-after` when over);
 * 3. check the route's scope;
 * 4. validate path params, query, and JSON body with the route's zod schemas (400 `validation_error`);
 * 5. call the handler, mapping {@link ApiError}s to `{ error: { code, message } }` and anything else to a logged 500.
 *
 * Dependencies (database, queue, clock, limiter) are injected, so tests drive routes with plain `Request` objects.
 */
import { z } from "zod";
import type { Db } from "@/lib/db";
import type { FixFileReader } from "@/lib/fix/context";
import type { JobQueue } from "@/lib/jobs/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { authenticateRequest, rateLimitKey, requireScope, type ApiPrincipal } from "./auth";
import { ApiError, apiError } from "./http";
import type { ApiScope } from "./keys";
import type { RateLimiter } from "./rate-limit";

export interface ApiDeps {
  db: Db;
  queue: JobQueue;
  now: () => Date;
  limiter: RateLimiter;
  /** Requests per principal per minute. */
  rateLimitPerMinute: number;
  /** The app's origin, for the same-origin check on cookie-authenticated mutations. */
  appUrl: string;
  sessionTtlDays: number;
  /** Reads a file at a commit through the git host (fix prompts show current code); stored evidence otherwise. */
  readFile?: FixFileReader;
  log?: Logger;
}

export const RATE_LIMIT_WINDOW_MS = 60_000;

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface HandlerContext<P, Q, B> {
  deps: ApiDeps;
  req: Request;
  principal: ApiPrincipal;
  params: P;
  query: Q;
  body: B;
  log: Logger;
}

export interface ResponseDoc {
  description: string;
  /** JSON Schema of the response body, for the OpenAPI document. */
  schema?: z.ZodType;
  contentType?: string;
}

/** One API route. `path` uses OpenAPI templates (`/reviews/{id}`), relative to `/api/v1`. */
export interface RouteSpec<P = unknown, Q = unknown, B = unknown> {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tag: string;
  /** Scope the caller must hold; null = any authenticated caller. */
  scope: ApiScope | null;
  /** Public routes (the OpenAPI document) skip authentication and rate limiting. */
  public?: boolean;
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  body?: z.ZodType<B>;
  responses: Record<number, ResponseDoc>;
  /** Method syntax on purpose: routes with different param/query/body types share one table ({@link AnyRoute}). */
  handler(ctx: HandlerContext<P, Q, B>): Promise<Response>;
}

/** A route of any shape; each is type-checked against its own schemas where it is defined ({@link defineRoute}). */
export type AnyRoute = RouteSpec<unknown, unknown, unknown>;

/** Identity helper that type-checks a route spec against its own schemas. */
export function defineRoute<P = Record<string, never>, Q = Record<string, never>, B = undefined>(spec: RouteSpec<P, Q, B>): RouteSpec<P, Q, B> {
  return spec;
}

export function routeId(r: Pick<RouteSpec, "method" | "path">): string {
  return `${r.method} ${r.path}`;
}

/** Query string as an object: repeated keys become arrays. */
export function queryObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

function validationError(where: string, error: z.ZodError): ApiError {
  const issues = error.issues.slice(0, 10).map((i) => ({ path: [where, ...i.path.map(String)].join("."), message: i.message }));
  const first = issues[0];
  return new ApiError(400, "validation_error", first ? `Invalid ${first.path}: ${first.message}` : `Invalid ${where}.`, issues);
}

function parse<T>(schema: z.ZodType<T> | undefined, value: unknown, where: string): T {
  if (!schema) return undefined as T;
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(where, result.error);
  return result.data;
}

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(400, "bad_request", "Request body is too large.");
  if (!text.trim()) return {};
  if (!/^application\/(.+\+)?json\b/i.test(type)) throw new ApiError(400, "bad_request", "Send the request body as JSON (content-type: application/json).");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "bad_request", "Request body is not valid JSON.");
  }
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

/** Runs one route for a request (see the module comment). `rawParams` are the URL's path segments by name. */
export async function executeRoute(route: AnyRoute, deps: ApiDeps, req: Request, rawParams: Record<string, string | string[]> = {}): Promise<Response> {
  const baseLog = deps.log ?? rootLog.child({ component: "api" });
  let log = baseLog.child({ route: routeId(route) });
  let rateHeaders: Record<string, string> = {};
  try {
    let principal: ApiPrincipal | null = null;
    if (!route.public) {
      principal = await authenticateRequest(deps, req);
      log = log.child({ orgId: principal.orgId, actor: principal.actor.type === "api_key" ? `api_key:${principal.actor.keyId}` : principal.actor.userId });
      const decision = await deps.limiter.hit(`api:${rateLimitKey(principal)}`, deps.rateLimitPerMinute, RATE_LIMIT_WINDOW_MS, deps.now());
      rateHeaders = {
        "x-ratelimit-limit": String(decision.limit),
        "x-ratelimit-remaining": String(decision.remaining),
        "x-ratelimit-reset": String(Math.ceil(decision.resetAt.getTime() / 1000)),
      };
      if (!decision.allowed) {
        const retryAfter = Math.max(1, Math.ceil((decision.resetAt.getTime() - deps.now().getTime()) / 1000));
        log.warn("API rate limit exceeded", { limit: decision.limit });
        return apiError(429, "rate_limited", `Rate limit of ${decision.limit} requests per minute exceeded. Retry in ${retryAfter}s.`, {
          headers: { ...rateHeaders, "retry-after": String(retryAfter) },
        });
      }
      if (route.scope) requireScope(principal, route.scope);
    }
    const params = parse(route.params, rawParams, "path");
    const query = parse(route.query, queryObject(new URL(req.url)), "query");
    const body = route.body ? parse(route.body, await readJsonBody(req), "body") : undefined;
    const res = await route.handler({
      deps,
      req,
      // Public routes never read the principal.
      principal: principal as ApiPrincipal,
      params,
      query,
      body,
      log,
    });
    return withHeaders(res, rateHeaders);
  } catch (err) {
    if (err instanceof ApiError) {
      const headers: Record<string, string> = { ...rateHeaders };
      if (err.status === 401) headers["www-authenticate"] = 'Bearer realm="openreview"';
      return apiError(err.status, err.code, err.message, { headers, ...(err.details !== undefined ? { details: err.details } : {}) });
    }
    log.error("API request failed", { error: errorMessage(err) });
    return apiError(500, "internal_error", "Something went wrong. Try again; if it keeps failing, check the server logs.", { headers: rateHeaders });
  }
}
