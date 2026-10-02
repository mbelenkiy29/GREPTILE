import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets at rest (R6.20). Org-supplied credentials (BYO LLM keys, SSO client secrets, provider tokens) are stored as
 * `v1.<iv>.<tag>.<ciphertext>` (AES-256-GCM, base64url parts). The key is `ENCRYPTION_KEY` (32 bytes, base64) when set,
 * otherwise derived from `APP_SECRET` with HKDF so a minimal install still encrypts.
 */

const VERSION = "v1";

function keyMaterial(): Buffer {
  const explicit = process.env.ENCRYPTION_KEY;
  if (explicit) {
    const key = Buffer.from(explicit, "base64");
    if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    return key;
  }
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 16) throw new Error("APP_SECRET (at least 16 chars) or ENCRYPTION_KEY is required to encrypt secrets");
  return Buffer.from(hkdfSync("sha256", secret, "openreview", "secrets-at-rest-v1", 32));
}

export function encryptSecret(plaintext: string, key: Buffer = keyMaterial()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(sealed: string, key: Buffer = keyMaterial()): string {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error("unrecognized secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function isSealedSecret(value: string): boolean {
  return /^v1\.[\w-]+\.[\w-]+\.[\w-]*$/.test(value);
}

/** Random token for sessions, API keys, invites, and device codes (base64url, `bytes` of entropy). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** One-way hash for bearer tokens stored in the database (sessions, API keys, invites). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
