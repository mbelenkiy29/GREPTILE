import { createHash } from "node:crypto";
import { z } from "zod";
import { hmac, randomToken, safeEqual } from "@/lib/crypto";
import { OAUTH_MAX_AGE_S } from "./cookies";

/**
 * OAuth state and PKCE for "Sign in with GitHub" (R6.1). The random `state`, the PKCE `code_verifier`, and the
 * post-sign-in `next` path travel in one short-lived HttpOnly cookie, HMAC-signed with APP_SECRET so it cannot be
 * forged or altered. The authorize request carries the S256 challenge; the token exchange carries the verifier.
 */

export interface OAuthState {
  state: string;
  verifier: string;
  next: string;
  issuedAt: number;
}

const payloadSchema = z.object({ s: z.string().min(16), v: z.string().min(43).max(128), n: z.string(), t: z.number() });

/** A fresh state + PKCE verifier (43 base64url chars from 32 random bytes, within RFC 7636's 43–128). */
export function newOAuthState(next: string, now: number): OAuthState {
  return { state: randomToken(32), verifier: randomToken(32), next, issuedAt: now };
}

/** S256 code challenge: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function sealOAuthState(secret: string, s: OAuthState): string {
  const payload = Buffer.from(JSON.stringify({ s: s.state, v: s.verifier, n: s.next, t: s.issuedAt })).toString("base64url");
  return `${payload}.${hmac(secret, `oauth-state.${payload}`)}`;
}

/** Verifies the signature and age of a sealed state cookie. Returns null when missing, tampered, or expired. */
export function openOAuthState(secret: string, sealed: string | undefined, now: number): OAuthState | null {
  if (!sealed) return null;
  const dot = sealed.indexOf(".");
  if (dot <= 0) return null;
  const payload = sealed.slice(0, dot);
  const sig = sealed.slice(dot + 1);
  if (!safeEqual(sig, hmac(secret, `oauth-state.${payload}`))) return null;
  let parsed: z.infer<typeof payloadSchema>;
  try {
    parsed = payloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (now - parsed.t > OAUTH_MAX_AGE_S * 1000 || parsed.t > now + 60_000) return null;
  return { state: parsed.s, verifier: parsed.v, next: parsed.n, issuedAt: parsed.t };
}

/** Constant-time comparison of the `state` query parameter with the cookie's state. */
export function stateMatches(expected: OAuthState, given: string | null): boolean {
  return typeof given === "string" && given.length > 0 && safeEqual(given, expected.state);
}
