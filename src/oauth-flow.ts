import "server-only";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "../convex/_generated/api";
import { backend, cookieOptions, origin, seal, signSession, unseal } from "./server";
import { newSession, safeNext, type Profile } from "./identity";

// Shared OAuth sign-in: sealed one-time state, server-side session creation, optional explicit
// linking (`?link=1` while signed in), and a safe same-origin `next` redirect.
type Provider = "github" | "gitlab" | "google";
const stateCookie = (provider: Provider) => provider === "github" ? "openreview_oauth_state" : `openreview_oauth_${provider}`;
export const callbackUrl = (provider: Provider) => `${origin()}/api/auth/${provider === "github" ? "" : provider + "/"}callback`;
export async function beginOAuth(request: Request, provider: Provider, authorize: (state: string, redirectUri: string) => string) {
  const url = new URL(request.url), state = randomBytes(32).toString("hex");
  // purpose "github-install": a signed-in user re-authorizes GitHub only to verify an App installation.
  const purpose = provider === "github" && url.searchParams.get("purpose") === "github-install" ? "github-install" : undefined;
  (await cookies()).set(stateCookie(provider), await seal({ state, next: safeNext(url.searchParams.get("next")), link: url.searchParams.get("link") === "1", ...(purpose ? { purpose } : {}) }), { ...cookieOptions, maxAge: 600 });
  return NextResponse.redirect(authorize(state, callbackUrl(provider)));
}
export async function startSession(userId: string, sid: string) {
  (await cookies()).set("openreview_session", await signSession(userId, sid), { ...cookieOptions, maxAge: 7 * 86400 });
}
export async function finishOAuth(request: Request, provider: Provider, profile: (code: string, redirectUri: string) => Promise<Profile>, after?: () => Promise<void>) {
  const url = new URL(request.url), jar = await cookies(), cookie = jar.get(stateCookie(provider))?.value;
  jar.delete(stateCookie(provider));
  let next = "/dashboard";
  try {
    const code = url.searchParams.get("code");
    if (!cookie || !code || code.length > 2000) throw new Error("Missing OAuth state or code");
    const saved = z.object({ state: z.string(), next: z.string().optional(), link: z.boolean().optional(), purpose: z.literal("github-install").optional() }).passthrough().parse(await unseal(cookie));
    if (saved.state !== url.searchParams.get("state")) throw new Error("OAuth state mismatch");
    next = safeNext(saved.next);
    if (saved.purpose === "github-install") {
      // No sign-in, session or identity link: keep the current session and hand the fresh GitHub
      // token to the installation flow, which re-checks the user and workspace.
      const current = jar.get("openreview_session")?.value;
      if (!current || !(await backend().query(api.identity.sessionValid, { token: current }).catch(() => false))) throw new Error("Sign in before installing the GitHub App");
      await profile(code, callbackUrl(provider));
      await after?.();
      return NextResponse.redirect(origin() + next);
    }
    const p = await profile(code, callbackUrl(provider)), session = newSession();
    const linkToken = saved.link ? jar.get("openreview_session")?.value : undefined;
    const userId = await backend().mutation(api.identity.signIn, { secret: process.env.SERVICE_SECRET ?? "", provider, ...p, sessionHash: session.hash, userAgent: (await headers()).get("user-agent")?.slice(0, 200) ?? undefined, ...(linkToken ? { linkToken } : {}) });
    await startSession(userId, session.sid);
    await after?.();
    return NextResponse.redirect(origin() + next);
  } catch (error) {
    console.error(JSON.stringify({ event: "auth.failed", provider, error: error instanceof Error ? error.message.slice(0, 200) : "Authentication failed" }));
    return NextResponse.redirect(`${origin()}/login?error=signin`);
  }
}
