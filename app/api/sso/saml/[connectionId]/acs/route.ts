import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { newSession, safeNext } from "../../../../../../src/identity";
import { startSession } from "../../../../../../src/oauth-flow";
import { samlIdentity } from "../../../../../../src/sso";
import { loginConnection, samlFor, signInSso, ssoBase } from "../../../../../../src/sso-web";

export const dynamic = "force-dynamic";
// SAML assertion consumer service (HTTP-POST binding). The response must be signed by the workspace's
// IdP, be for this service provider, be in date, answer a request we issued, and not be reused.
export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const base = ssoBase(request.url);
  try {
    const { connectionId } = await params;
    const form = await request.formData();
    const response = form.get("SAMLResponse"), relay = form.get("RelayState");
    if (typeof response !== "string" || response.length > 500_000) throw new Error("Missing SAMLResponse");
    const c = await loginConnection({ connectionId });
    if (!c || c.protocol !== "saml") throw new Error("SSO connection is not active");
    const { profile } = await samlFor(base, c).validatePostResponseAsync({ SAMLResponse: response });
    if (!profile) throw new Error("No assertion");
    const who = samlIdentity(profile);
    if (!who.assertionId) throw new Error("Assertion without an ID");
    const session = newSession();
    const { userId } = await signInSso({ connectionId: c.id, subject: who.subject, email: who.email, name: who.name, assertionId: who.assertionId, assertionExpiresAt: who.expiresAt, sessionHash: session.hash, userAgent: (await headers()).get("user-agent")?.slice(0, 200) ?? undefined });
    await startSession(userId, session.sid);
    return NextResponse.redirect(base + safeNext(typeof relay === "string" ? relay : null), 303);
  } catch (error) {
    console.error(JSON.stringify({ event: "sso.failed", protocol: "saml", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }));
    return NextResponse.redirect(`${base}/login?error=sso`, 303);
  }
}
