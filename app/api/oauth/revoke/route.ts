import { api } from "../../../../convex/_generated/api";
import { tokenHash } from "../../../../src/oauth-server";
import { backend } from "../../../../src/server";

// RFC 7009 token revocation: either token of a grant revokes the whole grant. Always 200.
export async function POST(request: Request) {
  const params = new URLSearchParams(await request.text().catch(() => ""));
  const token = params.get("token");
  if (token && token.length <= 200) await backend().mutation(api.oauth.revokeToken, { secret: process.env.SERVICE_SECRET ?? "", hash: tokenHash(token), ...(params.get("client_id") ? { clientId: params.get("client_id")! } : {}) }).catch(() => undefined);
  return new Response(null, { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
}
