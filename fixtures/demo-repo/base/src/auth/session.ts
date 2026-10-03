import { createHmac, timingSafeEqual } from "node:crypto";

export interface Session {
  userId: string;
  expiresAt: number;
}

/**
 * Parses a `userId.expiresAt.signature` bearer token signed with HMAC-SHA256. Returns null when the token is
 * malformed, has a bad signature, or has expired.
 */
export function parseSession(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token) return null;
  const [userId, expires, signature] = token.split(".");
  if (!userId || !expires || !signature) return null;
  const expected = createHmac("sha256", secret).update(`${userId}.${expires}`).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { userId, expiresAt };
}
