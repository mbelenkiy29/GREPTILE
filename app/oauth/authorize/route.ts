import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizationRequest, mcpResource, oauthBase, redirectWith } from "../../../src/oauth-server";
import { resolveClient } from "../../../src/oauth-clients";
import { cookieOptions, seal } from "../../../src/server";

export const dynamic = "force-dynamic";
// OAuth 2.1 authorization endpoint. Client and redirect URI are verified before anything is redirected;
// the validated request is sealed into a short-lived cookie and the user decides on /oauth/consent.
const problem = (message: string) => new Response(`OpenReview could not start this authorization: ${message}`, { status: 400, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
export async function GET(request: Request) {
  const base = oauthBase(request.url);
  const params = Object.fromEntries(new URL(request.url).searchParams);
  if (!params.client_id || !params.redirect_uri) return problem("client_id and redirect_uri are required.");
  const resolved = await resolveClient(params.client_id);
  if ("error" in resolved) return problem(resolved.error);
  if (!resolved.client.redirectUris.includes(params.redirect_uri)) return problem("redirect_uri is not registered for this client.");
  const fail = (error: string, description: string) => NextResponse.redirect(redirectWith(params.redirect_uri, { error, error_description: description, state: params.state, iss: base }), 302);
  if (params.response_type !== "code") return fail("unsupported_response_type", "Only the authorization code flow is supported");
  const parsed = authorizationRequest.safeParse(params);
  if (!parsed.success) return fail(parsed.error.issues.some((i) => i.path[0] === "scope") ? "invalid_scope" : "invalid_request", parsed.error.issues[0]?.message.slice(0, 200) ?? "Invalid request");
  const resource = mcpResource(base);
  if (parsed.data.resource && parsed.data.resource.replace(/\/+$/, "").toLowerCase() !== resource.toLowerCase()) return fail("invalid_target", `This server issues tokens only for ${resource}`);
  (await cookies()).set("openreview_oauth_request", await seal({ clientId: resolved.client.clientId, clientName: resolved.client.name, redirectUri: parsed.data.redirect_uri, codeChallenge: parsed.data.code_challenge, scopes: parsed.data.scope ?? ["read"], state: parsed.data.state, resource, issuer: base }), { ...cookieOptions, maxAge: 600, path: "/oauth" });
  return NextResponse.redirect(`${base}/oauth/consent`, 302);
}
