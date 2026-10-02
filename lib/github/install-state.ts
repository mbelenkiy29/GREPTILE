import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_MS = 60 * 60 * 1000;

function mac(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Signed `state` for the GitHub App install redirect. It binds the installation that comes back to the org (and
 * the user) that started the flow (R1.1).
 */
export function signInstallState(secret: string, orgId: string, now = Date.now(), userId?: string): string {
  const payload = Buffer.from(JSON.stringify({ o: orgId, t: now, ...(userId ? { u: userId } : {}) })).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

export function verifyInstallState(
  secret: string,
  state: string,
  now = Date.now(),
): { orgId: string; userId?: string } | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { o, t, u } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { o: unknown; t: unknown; u?: unknown };
    if (typeof o !== "string" || typeof t !== "number" || now - t > MAX_AGE_MS || t > now + 60_000) return null;
    if (u !== undefined && typeof u !== "string") return null;
    return typeof u === "string" ? { orgId: o, userId: u } : { orgId: o };
  } catch {
    return null;
  }
}
