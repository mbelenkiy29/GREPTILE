import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ApiAuthError, apiIdentity, mcpRequests } from "../../../src/api-auth";
import { hasScope } from "../../../src/api-scopes";
import { registerOpenReviewTools, toolScopes } from "../../../src/mcp-tools";
import { bearerChallenge, oauthBase } from "../../../src/oauth-server";
import { inProcessApi } from "./dispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
// Remote MCP over Streamable HTTP (stateless, JSON responses). Accepts a Bearer API key or an OAuth
// access token issued for this endpoint; each request gets a fresh server bound to that identity.
// Unauthenticated requests get the RFC 9728 challenge pointing at the protected-resource metadata.
export async function POST(request: Request) {
  const base = oauthBase(request.url);
  mcpRequests.add(request);
  let scopes: string[];
  try {
    ({ scopes } = await apiIdentity(request, "read"));
  } catch (error) {
    const status = error instanceof ApiAuthError ? error.status : 401;
    const presented = Boolean(request.headers.get("authorization"));
    return Response.json({ error: error instanceof ApiAuthError ? error.message : "Authorization required" }, { status, headers: { "www-authenticate": bearerChallenge(base, presented ? { error: "invalid_token" } : {}) } });
  }
  // Runtime insufficient scope (MCP authorization, scope challenge): with an OAuth token, a tool call
  // that needs write or admin answers 403 with the scope to request so the client can step up. API keys
  // cannot step up, so they keep the tool-level error.
  const oauth = request.headers.get("authorization")!.startsWith("Bearer ora_");
  const message = oauth ? await request.clone().json().catch(() => null) as { method?: string; params?: { name?: string } } | null : null;
  const required = message?.method === "tools/call" ? toolScopes[message.params?.name as keyof typeof toolScopes] : undefined;
  if (required && !hasScope(scopes, required)) return Response.json({ error: `This tool needs the ${required} scope` }, { status: 403, headers: { "www-authenticate": bearerChallenge(base, { error: "insufficient_scope", scope: required, description: `The ${message!.params!.name} tool needs the ${required} scope` }) } });
  const server = new McpServer({ name: "openreview", version: "0.2.0" });
  registerOpenReviewTools(server, inProcessApi(new URL(request.url).origin, request.headers.get("authorization")!, request.signal));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}
// Stateless server: no standalone SSE stream or session to delete.
const notAllowed = () => Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed; POST JSON-RPC messages to this endpoint" }, id: null }, { status: 405, headers: { allow: "POST" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
