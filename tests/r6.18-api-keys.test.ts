import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createApiKeyAudited, parseApiKeyForm, revokeApiKeyAudited } from "@/lib/api/key-admin";
import { API_KEY_PATTERN, authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from "@/lib/api/keys";
import { MemoryRateLimiter } from "@/lib/api/rate-limit";
import { hashToken } from "@/lib/crypto";
import { listAudit } from "@/lib/data/audit";
import { apiKeys, orgs } from "@/lib/db/schema";
import { redactText } from "@/lib/log";
import { makeUser } from "./helpers/auth";
import { createTestDb } from "./helpers/db";

const NOW = new Date("2026-03-01T12:00:00Z");

async function setup() {
  const db = await createTestDb();
  await db.insert(orgs).values([
    { id: "org_a", name: "Acme" },
    { id: "org_b", name: "Globex" },
  ]);
  return db;
}

describe("API keys (R6.18)", () => {
  test("R6.18 key creation returns the token once and stores only its SHA-256 hash and display prefix", async () => {
    const db = await setup();
    const { key, token } = await createApiKey(db, { orgId: "org_a", createdBy: null, name: " CI ", scopes: ["reviews:write", "repos:read"], expiresInDays: 30, now: NOW });
    expect(token).toMatch(API_KEY_PATTERN);
    expect(key.name).toBe("CI");
    expect(key.prefix).toBe(token.slice("or_live_".length, "or_live_".length + 8));
    // Scopes are normalized to the canonical order.
    expect(key.scopes).toEqual(["repos:read", "reviews:write"]);
    expect(key.expiresAt?.toISOString()).toBe("2026-03-31T12:00:00.000Z");

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row!.tokenHash).toBe(hashToken(token));
    // The raw token appears nowhere in the stored row.
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token.slice(16));
    // Listing never exposes the hash or the token.
    const listed = await listApiKeys(db, "org_a");
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(row!.tokenHash);
    expect(await listApiKeys(db, "org_b")).toEqual([]);
    // Two keys never share a token.
    const second = await createApiKey(db, { orgId: "org_a", createdBy: null, name: "Other", scopes: ["repos:read"], expiresInDays: null });
    expect(second.token).not.toBe(token);
    // Tokens are redacted from logs.
    expect(redactText(`using ${token} now`)).toBe("using [REDACTED] now");
  });

  test("R6.18 unknown, malformed, revoked, and expired keys are rejected; valid keys authenticate as their org", async () => {
    const db = await setup();
    const valid = await createApiKey(db, { orgId: "org_a", createdBy: null, name: "valid", scopes: ["repos:read"], expiresInDays: null, now: NOW });
    const ok = await authenticateApiKey(db, valid.token, NOW);
    expect(ok).toMatchObject({ ok: true, key: { orgId: "org_a", orgName: "Acme", scopes: ["repos:read"] } });
    const [touched] = await db.select().from(apiKeys).where(eq(apiKeys.id, valid.key.id));
    expect(touched!.lastUsedAt?.toISOString()).toBe(NOW.toISOString());

    expect(await authenticateApiKey(db, "or_live_" + "A".repeat(43), NOW)).toEqual({ ok: false, reason: "unknown" });
    expect(await authenticateApiKey(db, "not-a-key", NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(await authenticateApiKey(db, valid.token + "x", NOW)).toEqual({ ok: false, reason: "malformed" });

    const revoked = await createApiKey(db, { orgId: "org_a", createdBy: null, name: "revoked", scopes: ["repos:read"], expiresInDays: null, now: NOW });
    expect(await revokeApiKey(db, "org_b", revoked.key.id, NOW)).toBeUndefined(); // another org cannot revoke it
    expect(await revokeApiKey(db, "org_a", revoked.key.id, NOW)).toMatchObject({ id: revoked.key.id });
    expect(await revokeApiKey(db, "org_a", revoked.key.id, NOW)).toBeUndefined(); // already revoked
    expect(await authenticateApiKey(db, revoked.token, NOW)).toEqual({ ok: false, reason: "revoked" });

    const expiring = await createApiKey(db, { orgId: "org_a", createdBy: null, name: "short", scopes: ["repos:read"], expiresInDays: 1, now: NOW });
    expect((await authenticateApiKey(db, expiring.token, new Date(NOW.getTime() + 3600_000))).ok).toBe(true);
    expect(await authenticateApiKey(db, expiring.token, new Date(NOW.getTime() + 86_400_000))).toEqual({ ok: false, reason: "expired" });
  });

  test("R6.18 dashboard key management validates the form and audits creation and revocation", async () => {
    const db = await setup();
    const form = new FormData();
    form.set("name", "Deploy bot");
    form.append("scopes", "reviews:read");
    form.append("scopes", "reviews:write");
    form.set("expiresInDays", "90");
    const parsed = parseApiKeyForm(form);
    expect(parsed).toEqual({ ok: true, input: { name: "Deploy bot", scopes: ["reviews:read", "reviews:write"], expiresInDays: 90 } });

    const bad = new FormData();
    bad.set("name", "x");
    expect(parseApiKeyForm(bad)).toEqual({ ok: false, error: "Choose at least one scope." });
    const badScope = new FormData();
    badScope.set("name", "x");
    badScope.append("scopes", "admin:everything");
    expect(parseApiKeyForm(badScope).ok).toBe(false);
    const never = new FormData();
    never.set("name", "forever");
    never.append("scopes", "repos:read");
    never.set("expiresInDays", "");
    expect(parseApiKeyForm(never)).toMatchObject({ ok: true, input: { expiresInDays: null } });

    if (!parsed.ok) throw new Error("unreachable");
    const admin = await makeUser(db, "admin");
    const created = await createApiKeyAudited(db, { orgId: "org_a", userId: admin.id, ip: "203.0.113.9", now: NOW }, parsed.input);
    expect(await revokeApiKeyAudited(db, { orgId: "org_b", userId: "usr_other" }, created.key.id)).toBeUndefined();
    await revokeApiKeyAudited(db, { orgId: "org_a", userId: admin.id, now: NOW }, created.key.id);
    const audit = await listAudit(db, "org_a");
    expect(audit.map((a) => a.action).sort()).toEqual(["api_key.created", "api_key.revoked"]);
    const createdEntry = audit.find((a) => a.action === "api_key.created")!;
    expect(createdEntry).toMatchObject({ actorType: "user", actorId: admin.id, targetType: "api_key", targetId: String(created.key.id), ip: "203.0.113.9" });
    expect(createdEntry.metadata).toMatchObject({ name: "Deploy bot", scopes: ["reviews:read", "reviews:write"] });
    expect(JSON.stringify(audit)).not.toContain(created.token);
    expect(await listAudit(db, "org_b")).toEqual([]);
  });

  test("R6.18 the in-memory rate limiter counts a fixed one-minute window per key", async () => {
    const limiter = new MemoryRateLimiter();
    const t0 = new Date("2026-03-01T12:00:10Z");
    expect(await limiter.hit("k1", 2, 60_000, t0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await limiter.hit("k1", 2, 60_000, t0)).toMatchObject({ allowed: true, remaining: 0 });
    const over = await limiter.hit("k1", 2, 60_000, t0);
    expect(over).toMatchObject({ allowed: false, remaining: 0 });
    expect(over.resetAt.toISOString()).toBe("2026-03-01T12:01:00.000Z");
    expect((await limiter.hit("k2", 2, 60_000, t0)).allowed).toBe(true);
    expect((await limiter.hit("k1", 2, 60_000, new Date("2026-03-01T12:01:00Z"))).allowed).toBe(true);
  });
});
