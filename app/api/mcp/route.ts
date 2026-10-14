import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { apiFailure, apiIdentity } from "../../../src/api-auth";
import { registerOpenReviewTools } from "../../../src/mcp-tools";
import { inProcessApi } from "./dispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
// Remote MCP over Streamable HTTP (stateless, JSON responses). Requires a Bearer API key;
// each request gets a fresh server bound to that key.
export async function POST(request: Request) {
  try {
    await apiIdentity(request, "read");
  } catch (error) {
    const denied = apiFailure(error, { status: 401, error: "API key required" });
    return new Response(denied.body, { status: denied.status, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="openreview"' } });
  }
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
