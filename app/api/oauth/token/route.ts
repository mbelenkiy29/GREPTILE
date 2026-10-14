import { api } from "../../../../convex/_generated/api";
import { accessTokenSeconds, mcpResource, newSecret, oauthBase, refreshTokenDays, s256, tokenHash, validVerifier } from "../../../../src/oauth-server";
import { backend } from "../../../../src/server";

// OAuth 2.1 token endpoint for public clients (PKCE, no client secret): authorization_code and
// refresh_token grants. Tokens are opaque; only their hashes are stored.
const headers = { "cache-control": "no-store", pragma: "no-cache", "access-control-allow-origin": "*" };
const fail = (error: string, description: string, status = 400) => Response.json({ error, error_description: description }, { status, headers });
async function form(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) return new URLSearchParams(await request.text());
  if (type.includes("application/json")) return new URLSearchParams(Object.entries(await request.json() as Record<string, string>).map(([k, v]) => [k, String(v)]));
  return null;
}
export async function POST(request: Request) {
  const params = await form(request).catch(() => null);
  if (!params) return fail("invalid_request", "Send application/x-www-form-urlencoded parameters");
  const base = oauthBase(request.url), secret = process.env.SERVICE_SECRET ?? "";
  const clientId = params.get("client_id") ?? "", resource = params.get("resource") ?? undefined;
  if (!clientId) return fail("invalid_client", "client_id is required", 401);
  if (resource !== undefined && resource.replace(/\/+$/, "").toLowerCase() !== mcpResource(base).toLowerCase()) return fail("invalid_target", `This server issues tokens only for ${mcpResource(base)}`);
  const access = newSecret("ora_"), refresh = newSecret("orr_");
  const lifetimes = { accessHash: tokenHash(access), refreshHash: tokenHash(refresh), accessSeconds: accessTokenSeconds, refreshDays: refreshTokenDays };
  let result: { error: string } | { scopes: string[] };
  const grant = params.get("grant_type");
  if (grant === "authorization_code") {
    const code = params.get("code") ?? "", verifier = params.get("code_verifier") ?? "", redirectUri = params.get("redirect_uri") ?? "";
    if (!code || !redirectUri) return fail("invalid_request", "code and redirect_uri are required");
    if (!validVerifier(verifier)) return fail("invalid_grant", "A valid PKCE code_verifier is required");
    result = await backend().mutation(api.oauth.exchange, { secret, hash: tokenHash(code), clientId, redirectUri, codeChallenge: s256(verifier), ...(resource ? { resource: mcpResource(base) } : {}), ...lifetimes });
  } else if (grant === "refresh_token") {
    const token = params.get("refresh_token") ?? "";
    if (!token) return fail("invalid_request", "refresh_token is required");
    result = await backend().mutation(api.oauth.refresh, { secret, hash: tokenHash(token), clientId, ...(resource ? { resource: mcpResource(base) } : {}), ...lifetimes });
  } else return fail("unsupported_grant_type", "Use authorization_code or refresh_token");
  if ("error" in result) return fail(result.error, "The grant is invalid, expired, already used or issued to another client");
  return Response.json({ access_token: access, token_type: "Bearer", expires_in: accessTokenSeconds, refresh_token: refresh, scope: result.scopes.join(" ") }, { headers });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } }); }
