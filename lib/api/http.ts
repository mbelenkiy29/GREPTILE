/**
 * Response conventions of the REST API (R6.18): JSON bodies, errors as `{ error: { code, message } }`, and
 * `cache-control: no-store` on everything (responses are per-tenant).
 */

export const API_ERROR_CODES = [
  "bad_request",
  "validation_error",
  "unauthorized",
  "forbidden",
  "insufficient_scope",
  "csrf_failed",
  "not_found",
  "conflict",
  "rate_limited",
  "usage_limit",
  "unavailable",
  "timeout",
  "internal_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Thrown by handlers to answer with an error; anything else becomes a 500 `internal_error`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found.`);

const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function apiJson(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(BASE_HEADERS);
  for (const [k, v] of new Headers(headers)) h.set(k, v);
  return Response.json(data, { status, headers: h });
}

export function apiError(status: number, code: ApiErrorCode, message: string, opts: { headers?: HeadersInit; details?: unknown } = {}): Response {
  return apiJson({ error: { code, message, ...(opts.details !== undefined ? { details: opts.details } : {}) } }, status, opts.headers);
}

export function apiText(body: string, contentType: string, headers: HeadersInit = {}): Response {
  const h = new Headers(BASE_HEADERS);
  h.set("content-type", contentType);
  for (const [k, v] of new Headers(headers)) h.set(k, v);
  return new Response(body, { status: 200, headers: h });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

/** A page of results in the API's pagination envelope. */
export function paginated<T>(page: { items: T[]; total: number; page: number; pageSize: number; pageCount: number }) {
  return {
    data: page.items,
    pagination: { page: page.page, pageSize: page.pageSize, total: page.total, pageCount: page.pageCount, hasMore: page.page < page.pageCount },
  };
}
