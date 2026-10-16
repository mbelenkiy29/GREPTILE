import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { newSession, safeNext } from "../../../../../src/identity";
import { startSession } from "../../../../../src/oauth-flow";
import { oidcFinish } from "../../../../../src/sso";
import { loginConnection, oidcFor, signInSso, ssoBase } from "../../../../../src/sso-web";
import { unseal } from "../../../../../src/server";

export const dynamic = "force-dynamic";
// OIDC redirect URI: PKCE verifier, state and nonce come from the sealed cookie set by /sso/start.
export async function GET(request: Request) {
  const base = ssoBase(request.url), jar = await cookies(), sealed = jar.get("openreview_sso")?.value;
  jar.delete("openreview_sso");
  try {
    if (!sealed) throw new Error("Missing SSO state");
    const saved = z.object({ connectionId: z.string(), verifier: z.string(), state: z.string(), nonce: z.string(), next: z.string() }).parse(await unseal(sealed));
    const c = await loginConnection({ connectionId: saved.connectionId });
    if (!c) throw new Error("SSO connection is not active");
    const callback = new URL(request.url), current = new URL(`${base}/api/sso/oidc/callback${callback.search}`);
    const who = await oidcFinish(await oidcFor(c), current, saved);
    const session = newSession();
    const { userId } = await signInSso({ connectionId: c.id, subject: who.subject, email: who.email, emailVerifiedByIdp: who.emailVerified, name: who.name, sessionHash: session.hash, userAgent: (await headers()).get("user-agent")?.slice(0, 200) ?? undefined });
    await startSession(userId, session.sid);
    return NextResponse.redirect(base + safeNext(saved.next));
  } catch (error) {
    console.error(JSON.stringify({ event: "sso.failed", protocol: "oidc", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }));
    return NextResponse.redirect(`${base}/?error=sso`);
  }
}
