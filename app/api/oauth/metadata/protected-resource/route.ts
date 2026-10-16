import { oauthBase, protectedResourceMetadata } from "../../../../../src/oauth-server";

// RFC 9728 Protected Resource Metadata for the MCP endpoint. Served (via rewrites in next.config.ts)
// at /.well-known/oauth-protected-resource/api/mcp and at the root well-known path.
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "cache-control": "public, max-age=300" };
export async function GET(request: Request) {
  return Response.json(protectedResourceMetadata(oauthBase(request.url)), { headers: cors });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers: cors }); }
