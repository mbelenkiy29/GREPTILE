import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import { newSecret, validRedirectUri } from "../../../../src/oauth-server";
import { backend } from "../../../../src/server";

// RFC 7591 Dynamic Client Registration for MCP clients that do not support Client ID Metadata
// Documents yet (the MCP specification deprecates it but allows it). Public clients only.
const headers = { "cache-control": "no-store", "access-control-allow-origin": "*" };
const registration = z.object({
  redirect_uris: z.array(z.string().max(500)).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
}).passthrough();
export async function POST(request: Request) {
  const parsed = registration.safeParse(await request.json().catch(() => null));
  const fail = (error: string, description: string) => Response.json({ error, error_description: description }, { status: 400, headers });
  if (!parsed.success) return fail("invalid_client_metadata", "redirect_uris is required");
  const d = parsed.data;
  if (!d.redirect_uris.every(validRedirectUri)) return fail("invalid_redirect_uri", "Redirect URIs must use HTTPS or a loopback http address, without fragments");
  if ((d.token_endpoint_auth_method ?? "none") !== "none") return fail("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported");
  if (d.response_types && !d.response_types.includes("code")) return fail("invalid_client_metadata", "The client must use the authorization code flow");
  const clientId = newSecret("orc_");
  try {
    await backend().mutation(api.oauth.saveClient, { secret: process.env.SERVICE_SECRET ?? "", clientId, name: d.client_name ?? "MCP client", redirectUris: d.redirect_uris, kind: "registered" });
  } catch { return fail("invalid_client_metadata", "Registration failed"); }
  return Response.json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: d.client_name ?? "MCP client", redirect_uris: d.redirect_uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }, { status: 201, headers });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } }); }
