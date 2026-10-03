import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { decryptSecret, encryptSecret, hashToken, isSealedSecret, randomToken, safeEqual } from "@/lib/crypto";
import { createLogger, redact, redactText, setLogSink } from "@/lib/log";

describe("secrets at rest and redaction", () => {
  test("R6.20 encrypts secrets with AES-GCM and rejects tampering or the wrong key", () => {
    const key = randomBytes(32);
    const sealed = encryptSecret("sk-ant-super-secret-value", key);
    expect(isSealedSecret(sealed)).toBe(true);
    expect(sealed).not.toContain("super-secret");
    expect(decryptSecret(sealed, key)).toBe("sk-ant-super-secret-value");
    // Same plaintext encrypts differently every time (random IV).
    expect(encryptSecret("sk-ant-super-secret-value", key)).not.toBe(sealed);
    const [v, iv, tag, ct] = sealed.split(".");
    // Tamper at the byte level so the ciphertext is guaranteed to change (a base64url character swap can be a no-op).
    const ctBytes = Buffer.from(ct!, "base64url");
    ctBytes[0]! ^= 0x01;
    const flipped = `${v}.${iv}.${tag}.${ctBytes.toString("base64url")}`;
    expect(flipped).not.toBe(sealed);
    expect(() => decryptSecret(flipped, key)).toThrow();
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
  });

  test("R6.20 derives the encryption key from APP_SECRET when ENCRYPTION_KEY is unset", () => {
    const prev = { key: process.env.ENCRYPTION_KEY, secret: process.env.APP_SECRET };
    try {
      delete process.env.ENCRYPTION_KEY;
      process.env.APP_SECRET = "a-long-enough-app-secret";
      expect(decryptSecret(encryptSecret("hello"))).toBe("hello");
      process.env.ENCRYPTION_KEY = "too-short";
      expect(() => encryptSecret("hello")).toThrow(/32 bytes/);
    } finally {
      if (prev.key === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prev.key;
      if (prev.secret === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = prev.secret;
    }
  });

  test("R6.20 hashes bearer tokens and compares in constant time", () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("R6.20 redacts credentials from log text and secret-named fields", () => {
    expect(redactText("clone https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b.git")).toBe(
      "clone https://[REDACTED]@github.com/a/b.git",
    );
    expect(redactText("key sk-ant-api03-abcdefghijklmnop used")).toBe("key [REDACTED] used");
    expect(redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: [REDACTED]");
    expect(redact({ apiKey: "x", nested: { password: "p", ok: "fine" }, enabled: true })).toEqual({
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", ok: "fine" },
      enabled: true,
    });
  });
});

describe("structured logging", () => {
  test("R6.21 writes JSON lines carrying correlation ids from child loggers", () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const review = createLogger({ service: "test" }).child({ deliveryId: "d-1", repoId: 4 }).child({ reviewRunId: 9, agent: "security" });
      review.info("agent finished", { findings: 2, token: "ghp_abcdefghijklmnopqrstuvwxyz0123" });
      review.debug("detail");
    } finally {
      restore();
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
    expect(lines).toHaveLength(2);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      level: "info",
      msg: "agent finished",
      service: "test",
      deliveryId: "d-1",
      repoId: 4,
      reviewRunId: 9,
      agent: "security",
      findings: 2,
      token: "[REDACTED]",
    });
    expect(typeof entry.ts).toBe("string");
  });
});
