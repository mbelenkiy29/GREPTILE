import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { oidcStart } from "../../../src/sso";
import { loginConnection, oidcFor, samlFor, ssoBase } from "../../../src/sso-web";
import { safeNext } from "../../../src/identity";
import { cookieOptions, seal } from "../../../src/server";

export const dynamic = "force-dynamic";
// Start SSO for an email address (its verified domain picks the workspace connection) or a connection id.
export async function GET(request: Request) {
  const url = new URL(request.url), base = ssoBase(request.url);
  const email = url.searchParams.get("email")?.slice(0, 320), connectionId = url.searchParams.get("connection")?.slice(0, 64);
  const next = safeNext(url.searchParams.get("next"));
  try {
    const c = await loginConnection({ ...(email ? { email } : {}), ...(connectionId ? { connectionId } : {}) });
    if (!c) return NextResponse.redirect(`${base}/login?error=sso`);
    if (c.protocol === "oidc") {
      const start = await oidcStart(await oidcFor(c), `${base}/api/sso/oidc/callback`);
      (await cookies()).set("openreview_sso", await seal({ connectionId: c.id, verifier: start.verifier, state: start.state, nonce: start.nonce, next }), { ...cookieOptions, maxAge: 600 });
      return NextResponse.redirect(start.url.toString());
    }
    return NextResponse.redirect(await samlFor(base, c).getAuthorizeUrlAsync(next, undefined, {}));
  } catch (error) {
    console.error(JSON.stringify({ event: "sso.start_failed", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }));
    return NextResponse.redirect(`${base}/login?error=sso`);
  }
}
