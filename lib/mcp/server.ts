/**
 * The remote MCP server (R3.2): Streamable HTTP at `/api/mcp`, authenticated with REST API keys.
 *
 * Each HTTP request is handled statelessly (no MCP session id): authenticate the bearer key, rate-limit it with the
 * API limiter, build a fresh MCP server whose tools run the REST v1 routes in-process as that key
 * ({@link inProcessApi}), let the SDK's web-standard transport answer the JSON-RPC message with a JSON response, and
 * tear both down. Scopes, tenant isolation, validation, and auditing therefore come from the same route code as the
 * REST API.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateApiKey } from "@/lib/api/keys";
import { ApiError, apiError } from "@/lib/api/http";
import { actorLabel, rateLimitKey, type ApiPrincipal } from "@/lib/api/auth";
import { executeRouteAs, matchRoute, RATE_LIMIT_WINDOW_MS, rateLimitHeaders, rateLimitedResponse, type ApiDeps } from "@/lib/api/router";
import { V1_BASE_PATH, V1_ROUTES } from "@/lib/api/v1";
import { errorMessage, log as rootLog } from "@/lib/log";
import { isSameOrigin } from "@/lib/security/csrf";
import { APP_VERSION } from "@/lib/version";
import { createOpenReviewMcpServer, OpenReviewApiError, queryString, type OpenReviewApi } from "@/packages/mcp/src/tools";

/** Runs REST v1 routes in-process as `principal` (the MCP tools' API on the server). */
export function inProcessApi(deps: ApiDeps, principal: ApiPrincipal): OpenReviewApi {
  return {
    async request(method, path, { query, body } = {}) {
      const target = path.split("?")[0] ?? path;
      const match = matchRoute(V1_ROUTES, method, target);
      if (!match) throw new OpenReviewApiError(404, "not_found", `No API route for ${method} ${target}.`);
      const url = new URL(`${V1_BASE_PATH}${target}${queryString(query)}`, deps.appUrl);
      const headers = new Headers({ accept: "application/json" });
      if (body !== undefined) headers.set("content-type", "application/json");
      const req = new Request(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const res = await executeRouteAs(match.route, deps, req, match.params, principal);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
        throw new OpenReviewApiError(res.status, typeof err?.code === "string" ? err.code : "internal_error", typeof err?.message === "string" ? err.message : `HTTP ${res.status}`);
      }
      return json;
    },
  };
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

const KEY_FAILURE: Record<"malformed" | "unknown" | "revoked" | "expired", string> = {
  malformed: "The API key is not a valid OpenReview key.",
  unknown: "The API key is not valid.",
  revoked: "The API key has been revoked.",
  expired: "The API key has expired.",
};

/** The API-key principal of a request; MCP accepts bearer keys only (never the dashboard cookie). */
async function principalOf(deps: ApiDeps, req: Request): Promise<ApiPrincipal> {
  const header = req.headers.get("authorization");
  const m = header ? BEARER.exec(header) : null;
  if (!m) throw new ApiError(401, "unauthorized", "Authenticate with an OpenReview API key: `Authorization: Bearer or_live_…` (Settings → API keys).");
  const result = await authenticateApiKey(deps.db, m[1]!, deps.now());
  if (!result.ok) throw new ApiError(401, "unauthorized", KEY_FAILURE[result.reason]);
  const k = result.key;
  return { orgId: k.orgId, orgName: k.orgName, orgSlug: k.orgSlug, scopes: k.scopes, actor: { type: "api_key", keyId: k.id, name: k.name, prefix: k.prefix } };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  // Transport responses may have immutable headers; copy into a new Response.
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  h.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** Handles one MCP Streamable HTTP request (POST). */
export async function handleMcpRequest(deps: ApiDeps, req: Request): Promise<Response> {
  let log = (deps.log ?? rootLog).child({ component: "mcp" });
  let rateHeaders: Record<string, string> = {};
  try {
    // Streamable HTTP: servers must reject requests from foreign origins (DNS rebinding).
    if (req.headers.get("origin") !== null && !isSameOrigin(req, deps.appUrl)) {
      return apiError(403, "forbidden", "Cross-origin MCP requests are refused.");
    }
    const principal = await principalOf(deps, req);
    log = log.child({ orgId: principal.orgId, actor: actorLabel(principal) });
    const decision = await deps.limiter.hit(`api:${rateLimitKey(principal)}`, deps.rateLimitPerMinute, RATE_LIMIT_WINDOW_MS, deps.now());
    rateHeaders = rateLimitHeaders(decision);
    if (!decision.allowed) return rateLimitedResponse(decision, deps.now(), rateHeaders, log);

    const server = createOpenReviewMcpServer(inProcessApi({ ...deps, log }, principal), { name: "openreview", version: APP_VERSION });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req);
      return withHeaders(res, rateHeaders);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      const headers: Record<string, string> = { ...rateHeaders };
      if (err.status === 401) headers["www-authenticate"] = 'Bearer realm="openreview"';
      return apiError(err.status, err.code, err.message, { headers });
    }
    log.error("MCP request failed", { error: errorMessage(err) });
    return apiError(500, "internal_error", "Something went wrong. Try again; if it keeps failing, check the server logs.", { headers: rateHeaders });
  }
}

/**
 * GET (a standalone server-to-client SSE stream) and DELETE (session termination) need sessions, which this
 * stateless server does not keep: the Streamable HTTP spec answers both with 405.
 */
export function mcpMethodNotAllowed(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless; send JSON-RPC messages with POST." }, id: null }), {
    status: 405,
    headers: { allow: "POST", "content-type": "application/json", "cache-control": "no-store" },
  });
}
