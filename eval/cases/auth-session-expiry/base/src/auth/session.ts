import { createHmac, timingSafeEqual } from "node:crypto";

export interface Session {
  userId: string;
  expiresAt: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Verifies a `userId.expiresAt.signature` token; null when malformed, forged, or expired. */
export function verifySession(token: string, secret: string, now = Date.now()): Session | null {
  const [userId, expires, signature] = token.split(".");
  if (!userId || !expires || !signature) return null;
  const expected = Buffer.from(sign(`${userId}.${expires}`, secret), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { userId, expiresAt };
}

export function issueSession(userId: string, secret: string, ttlMs: number, now = Date.now()): string {
  const expiresAt = now + ttlMs;
  return `${userId}.${expiresAt}.${sign(`${userId}.${expiresAt}`, secret)}`;
}
