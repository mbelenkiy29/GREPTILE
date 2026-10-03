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
import type { EmbeddingProvider, LlmProvider } from "@/lib/llm/types";
import type { RunReview } from "@/lib/pipeline/engine";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { authenticateRequest, rateLimitKey, requireScope, type ApiPrincipal } from "./auth";
import { ApiError, apiError } from "./http";
import type { ApiScope } from "./keys";
import type { RateLimitDecision, RateLimiter } from "./rate-limit";

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
  /** Embeds codebase-search questions for semantic matches; without it search uses symbols, paths, and full text. */
  embedder?: EmbeddingProvider;
  /**
   * The review engine's model gateway and embedder for one org, for reviews the API runs itself (`POST /reviews/local`,
   * R3.5). Production uses the org's own model provider when it configured one (R4.6), see `orgReviewEngine`.
   */
  reviewEngine?: (orgId: string) => ReviewEngineDeps | Promise<ReviewEngineDeps>;
  /** How long `POST /reviews/local` may run before it is aborted. */
  localReviewTimeoutMs?: number;
  log?: Logger;
}

export interface ReviewEngineDeps {
  llm: LlmProvider;
  embedder?: EmbeddingProvider;
  /** The engine; defaults to `runReview` (tests inject one). */
  runReview?: RunReview;
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
  /** Largest accepted request body (default 64 KiB). */
  maxBodyBytes?: number;
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

async function readJsonBody(req: Request, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  const tooLarge = () => new ApiError(400, "bad_request", `Request body is too large (limit ${Math.floor(maxBytes / 1024)} KiB).`);
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) throw tooLarge();
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
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

/** Path parameters of `path` (relative to `/api/v1`) when it matches the route's template, else null. */
export function matchPath(route: Pick<RouteSpec, "path">, path: string): Record<string, string> | null {
  const names: string[] = [];
  const pattern = route.path.replace(/[.+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_, n: string) => (names.push(n), "([^/]+)"));
  const m = new RegExp(`^${pattern}$`).exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  names.forEach((n, i) => {
    params[n] = decodeURIComponent(m[i + 1]!);
  });
  return params;
}

/** The route of `routes` serving `method path` (path relative to `/api/v1`, without the query), with its params. */
export function matchRoute(routes: readonly AnyRoute[], method: string, path: string): { route: AnyRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const params = matchPath(route, path);
    if (params) return { route, params };
  }
  return null;
}

/** The `x-ratelimit-*` headers of a decision. */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
    "x-ratelimit-reset": String(Math.ceil(decision.resetAt.getTime() / 1000)),
  };
}

/** The 429 answer for a denied decision. */
export function rateLimitedResponse(decision: RateLimitDecision, now: Date, headers: Record<string, string>, log: Logger): Response {
  const retryAfter = Math.max(1, Math.ceil((decision.resetAt.getTime() - now.getTime()) / 1000));
  log.warn("API rate limit exceeded", { limit: decision.limit });
  return apiError(429, "rate_limited", `Rate limit of ${decision.limit} requests per minute exceeded. Retry in ${retryAfter}s.`, {
    headers: { ...headers, "retry-after": String(retryAfter) },
  });
}

function errorResponse(err: unknown, log: Logger, headers: Record<string, string>): Response {
  if (err instanceof ApiError) {
    const h: Record<string, string> = { ...headers };
    if (err.status === 401) h["www-authenticate"] = 'Bearer realm="openreview"';
    return apiError(err.status, err.code, err.message, { headers: h, ...(err.details !== undefined ? { details: err.details } : {}) });
  }
  log.error("API request failed", { error: errorMessage(err) });
  return apiError(500, "internal_error", "Something went wrong. Try again; if it keeps failing, check the server logs.", { headers });
}

/** Steps 3-5 of the pipeline (scope, validation, handler) once the caller is known (null: a public route). */
async function runAuthorized(route: AnyRoute, deps: ApiDeps, req: Request, rawParams: Record<string, string | string[]>, principal: ApiPrincipal | null, log: Logger) {
  if (principal && route.scope) requireScope(principal, route.scope);
  const params = parse(route.params, rawParams, "path");
  const query = parse(route.query, queryObject(new URL(req.url)), "query");
  const body = route.body ? parse(route.body, await readJsonBody(req, route.maxBodyBytes), "body") : undefined;
  return route.handler({
    deps,
    req,
    // Public routes never read the principal.
    principal: principal as ApiPrincipal,
    params,
    query,
    body,
    log,
  });
}

function actorOf(p: ApiPrincipal): string {
  return p.actor.type === "api_key" ? `api_key:${p.actor.keyId}` : p.actor.userId;
}

/**
 * Runs a route for a principal the caller already authenticated and rate-limited (the MCP endpoint runs its tools
 * through the REST routes this way): the route's scope check, validation, and tenant scoping apply exactly as over
 * HTTP, and errors come back as the same JSON error responses.
 */
export async function executeRouteAs(route: AnyRoute, deps: ApiDeps, req: Request, rawParams: Record<string, string | string[]>, principal: ApiPrincipal): Promise<Response> {
  const log = (deps.log ?? rootLog.child({ component: "api" })).child({ route: routeId(route), orgId: principal.orgId, actor: actorOf(principal) });
  try {
    return await runAuthorized(route, deps, req, rawParams, principal, log);
  } catch (err) {
    return errorResponse(err, log, {});
  }
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
      log = log.child({ orgId: principal.orgId, actor: actorOf(principal) });
      const decision = await deps.limiter.hit(`api:${rateLimitKey(principal)}`, deps.rateLimitPerMinute, RATE_LIMIT_WINDOW_MS, deps.now());
      rateHeaders = rateLimitHeaders(decision);
      if (!decision.allowed) return rateLimitedResponse(decision, deps.now(), rateHeaders, log);
    }
    const res = await runAuthorized(route, deps, req, rawParams, principal, log);
    return withHeaders(res, rateHeaders);
  } catch (err) {
    return errorResponse(err, log, rateHeaders);
  }
}
