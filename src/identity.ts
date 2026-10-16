import { randomBytes } from "node:crypto";
import { assertEgress } from "./egress";
import { z } from "zod";
import { sessionHash } from "./session-hash";

// Sign-in providers beyond GitHub. Profiles are normalised; an email counts as verified only when
// the provider says so (Google `email_verified`; gitlab.com confirmed accounts).
export type Profile = { providerUserId: string; login: string; avatar: string; email?: string; emailVerified: boolean };
export function newSession() { const sid = randomBytes(32).toString("base64url"); return { sid, hash: sessionHash(sid) }; }
export function safeNext(value: string | null | undefined) { return value && /^\/(?!\/)[A-Za-z0-9/_?=&.%-]{0,300}$/.test(value) ? value : "/dashboard"; }
const timeout = () => AbortSignal.timeout(30000);

export function gitlabBase() {
  const url = new URL(process.env.GITLAB_OAUTH_URL ?? "https://gitlab.com");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("GITLAB_OAUTH_URL must be an HTTPS origin");
  return url.origin;
}
export function gitlabAuthorizeUrl(clientId: string, redirectUri: string, state: string) {
  return `${gitlabBase()}/oauth/authorize?` + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", state, scope: "read_user" });
}
export async function gitlabProfile(code: string, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<Profile> {
  const base = gitlabBase();
  const token = await fetchImpl(`${base}/oauth/token`, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ client_id: process.env.GITLAB_OAUTH_CLIENT_ID ?? "", client_secret: process.env.GITLAB_OAUTH_CLIENT_SECRET ?? "", code, grant_type: "authorization_code", redirect_uri: redirectUri }), signal: timeout() });
  if (!token.ok) throw new Error("GitLab OAuth exchange failed");
  const access = z.object({ access_token: z.string().min(1) }).parse(await token.json()).access_token;
  const response = await fetchImpl(`${base}/api/v4/user`, { redirect: "error", headers: { authorization: `Bearer ${access}` }, signal: timeout() });
  if (!response.ok) throw new Error("GitLab profile request failed");
  const user = z.object({ id: z.number().int().positive(), username: z.string().min(1).max(255), avatar_url: z.string().nullish(), email: z.string().nullish(), confirmed_at: z.string().nullish() }).parse(await response.json());
  // Self-managed instances may skip confirmation, so only gitlab.com emails are trusted for linking.
  return { providerUserId: String(user.id), login: user.username, avatar: user.avatar_url ?? "", ...(user.email ? { email: user.email } : {}), emailVerified: Boolean(user.email && user.confirmed_at && base === "https://gitlab.com") };
}

export function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string) {
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
}
export async function googleProfile(code: string, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<Profile> {
  assertEgress("identity", "Google sign-in");
  const token = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", redirect_uri: redirectUri, grant_type: "authorization_code" }), signal: timeout() });
  if (!token.ok) throw new Error("Google OAuth exchange failed");
  const access = z.object({ access_token: z.string().min(1) }).parse(await token.json()).access_token;
  const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", { redirect: "error", headers: { authorization: `Bearer ${access}` }, signal: timeout() });
  if (!response.ok) throw new Error("Google profile request failed");
  const user = z.object({ sub: z.string().min(1).max(255), email: z.string().optional(), email_verified: z.boolean().optional(), name: z.string().optional(), picture: z.string().optional() }).parse(await response.json());
  return { providerUserId: user.sub, login: (user.email?.split("@")[0] ?? user.name ?? "user").slice(0, 100), avatar: user.picture ?? "", ...(user.email ? { email: user.email } : {}), emailVerified: user.email_verified === true };
}
