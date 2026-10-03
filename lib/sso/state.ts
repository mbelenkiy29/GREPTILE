/**
 * OIDC sign-in state (R4.6): `state`, `nonce`, the PKCE verifier, the connection, where to go next, and the user to
 * link (when someone already signed in starts SSO) travel in one short-lived HttpOnly cookie, HMAC-signed with
 * APP_SECRET so it cannot be forged or altered.
 */
import { z } from "zod";
import { hmac, randomToken, safeEqual } from "@/lib/crypto";

export const SSO_COOKIE = "or_sso";
export const SSO_COOKIE_PATH = "/api/auth/sso";
export const SSO_STATE_MAX_AGE_S = 10 * 60;

export interface SsoState {
  state: string;
  nonce: string;
  verifier: string;
  connectionId: string;
  next: string;
  linkUserId: string | null;
  issuedAt: number;
}

const payloadSchema = z.object({
  s: z.string().min(16),
  o: z.string().min(16),
  v: z.string().min(43).max(128),
  c: z.string().min(1).max(64),
  n: z.string().max(2048),
  u: z.string().max(64).nullable(),
  t: z.number(),
});

export function newSsoState(input: { connectionId: string; next: string; linkUserId: string | null; now: number }): SsoState {
  return { state: randomToken(32), nonce: randomToken(32), verifier: randomToken(32), connectionId: input.connectionId, next: input.next, linkUserId: input.linkUserId, issuedAt: input.now };
}

export function sealSsoState(secret: string, s: SsoState): string {
  const payload = Buffer.from(JSON.stringify({ s: s.state, o: s.nonce, v: s.verifier, c: s.connectionId, n: s.next, u: s.linkUserId, t: s.issuedAt })).toString("base64url");
  return `${payload}.${hmac(secret, `sso-state.${payload}`)}`;
}

/** Verifies signature and age. Null when missing, tampered, or expired. */
export function openSsoState(secret: string, sealed: string | undefined, now: number): SsoState | null {
  if (!sealed) return null;
  const dot = sealed.indexOf(".");
  if (dot <= 0) return null;
  const payload = sealed.slice(0, dot);
  if (!safeEqual(sealed.slice(dot + 1), hmac(secret, `sso-state.${payload}`))) return null;
  let p: z.infer<typeof payloadSchema>;
  try {
    p = payloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (now - p.t > SSO_STATE_MAX_AGE_S * 1000 || p.t > now + 60_000) return null;
  return { state: p.s, nonce: p.o, verifier: p.v, connectionId: p.c, next: p.n, linkUserId: p.u, issuedAt: p.t };
}
