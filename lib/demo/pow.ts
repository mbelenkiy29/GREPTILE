/**
 * Proof-of-work for the public demo (R3.7), instead of a third-party captcha. The server issues a signed challenge
 * (random nonce, difficulty, expiry; HMAC with APP_SECRET, so nothing is stored until it is used). The browser finds a
 * counter such that SHA-256(`<token>:<counter>`) starts with `difficulty` zero bits and submits it with the PR URL.
 * Each nonce is single use: the demo review row stores it under a unique index.
 */
import { createHash, randomBytes } from "node:crypto";
import { hmac, safeEqual } from "@/lib/crypto";
import { leadingZeroBits } from "./pow-solver";

export { leadingZeroBits };

export const POW_TTL_MS = 10 * 60_000;
const SOLUTION = /^\d{1,16}$/;

export interface PowChallenge {
  token: string;
  difficulty: number;
  expiresAt: string;
}

interface Payload {
  v: 1;
  n: string;
  d: number;
  e: number;
}

const sign = (secret: string, payload: string) => hmac(secret, `demo-pow:${payload}`);

export function issueChallenge(secret: string, opts: { difficulty: number; now?: Date; ttlMs?: number }): PowChallenge {
  const now = opts.now ?? new Date();
  const payload: Payload = { v: 1, n: randomBytes(16).toString("base64url"), d: opts.difficulty, e: now.getTime() + (opts.ttlMs ?? POW_TTL_MS) };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${encoded}.${sign(secret, encoded)}`, difficulty: payload.d, expiresAt: new Date(payload.e).toISOString() };
}

export function powHash(token: string, solution: string): Buffer {
  return createHash("sha256").update(`${token}:${solution}`).digest();
}

export type PowVerdict = { ok: true; nonce: string; difficulty: number } | { ok: false; reason: "malformed" | "signature" | "expired" | "difficulty" | "solution" };

/**
 * Checks a solved challenge: the token is ours (signature), unexpired, at least `minDifficulty` (a token issued
 * before the operator raised the difficulty is refused), and the solution meets the token's difficulty. Single use
 * is enforced where the nonce is stored.
 */
export function verifyPow(secret: string, token: string, solution: string, opts: { minDifficulty: number; now?: Date }): PowVerdict {
  const [encoded, mac, extra] = token.split(".");
  if (!encoded || !mac || extra !== undefined || token.length > 400 || !SOLUTION.test(solution)) return { ok: false, reason: "malformed" };
  if (!safeEqual(mac, sign(secret, encoded))) return { ok: false, reason: "signature" };
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Payload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.v !== 1 || typeof payload.n !== "string" || !Number.isInteger(payload.d) || typeof payload.e !== "number") return { ok: false, reason: "malformed" };
  if ((opts.now ?? new Date()).getTime() > payload.e) return { ok: false, reason: "expired" };
  if (payload.d < opts.minDifficulty) return { ok: false, reason: "difficulty" };
  if (leadingZeroBits(powHash(token, solution)) < payload.d) return { ok: false, reason: "solution" };
  return { ok: true, nonce: payload.n, difficulty: payload.d };
}

/** Finds a solution (used by tests and tools; browsers solve with SubtleCrypto). */
export function solvePow(token: string, difficulty: number, maxTries = 50_000_000): string {
  for (let i = 0; i < maxTries; i++) {
    if (leadingZeroBits(powHash(token, String(i))) >= difficulty) return String(i);
  }
  throw new Error("no solution found");
}
