import { authorizationServerMetadata, oauthBase } from "../../../../../src/oauth-server";

// RFC 8414 Authorization Server Metadata, served at /.well-known/oauth-authorization-server.
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "cache-control": "public, max-age=300" };
export async function GET(request: Request) {
  return Response.json(authorizationServerMetadata(oauthBase(request.url)), { headers: cors });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers: cors }); }
