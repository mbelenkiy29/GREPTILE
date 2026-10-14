import type { ApiCall } from "../../../src/mcp-tools";
import { mcpRequests } from "../../../src/api-auth";
import { GET as reviews, POST as requestReview } from "../reviews/route";
import { GET as reviewStatus } from "../reviews/status/route";
import { GET as unresolved } from "../findings/unresolved/route";
import { POST as suggestRule } from "../rules/suggestions/route";
import { GET as analytics } from "../analytics/route";
import { GET as review } from "../reviews/[id]/route";
import { POST as feedback } from "../findings/[id]/feedback/route";
import { GET as context } from "../context/route";
import { GET as repositories } from "../repositories/route";
import { POST as query } from "../query/route";
import { POST as search } from "../search/route";

// Remote MCP tool calls run the public API route handlers in-process with the caller's
// Authorization header, so scopes, tenant checks and validation are exactly the REST ones.
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes: [string, RegExp, Handler, string?][] = [
  ["GET", /^\/api\/reviews$/, reviews as Handler],
  ["POST", /^\/api\/reviews$/, requestReview as Handler],
  ["GET", /^\/api\/reviews\/status$/, reviewStatus as Handler],
  ["GET", /^\/api\/findings\/unresolved$/, unresolved as Handler],
  ["POST", /^\/api\/rules\/suggestions$/, suggestRule as Handler],
  ["GET", /^\/api\/analytics$/, analytics as Handler],
  ["GET", /^\/api\/reviews\/([^/]+)$/, review as Handler, "id"],
  ["POST", /^\/api\/findings\/([^/]+)\/feedback$/, feedback as Handler, "id"],
  ["GET", /^\/api\/context$/, context as Handler],
  ["GET", /^\/api\/repositories$/, repositories as Handler],
  ["POST", /^\/api\/query$/, query as Handler],
  ["POST", /^\/api\/search$/, search as Handler],
];
export function inProcessApi(origin: string, authorization: string, signal?: AbortSignal): ApiCall {
  return async (path, init = {}) => {
    const url = new URL(path, origin), method = init.method ?? "GET";
    const route = routes.find(([m, pattern]) => m === method && pattern.test(url.pathname));
    if (!route) return { status: 404, body: { error: "Unknown API path" } };
    const match = route[1].exec(url.pathname)!;
    const request = new Request(url, { method, headers: { authorization, "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), signal });
    mcpRequests.add(request);
    const response = await route[2](request, { params: Promise.resolve(route[3] ? { [route[3]]: decodeURIComponent(match[1]) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}
