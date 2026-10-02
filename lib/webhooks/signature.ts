import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies GitHub's `X-Hub-Signature-256` (HMAC-SHA256 of the raw body) in constant time. */
export function verifyGitHubSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signGitHubPayload(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
