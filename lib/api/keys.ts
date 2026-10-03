/**
 * REST API keys (R6.18). A key is `or_live_` + 32 random bytes (base64url). The raw token is returned once by
 * {@link createApiKey} and never stored: the database keeps its SHA-256 (`token_hash`) and the first 8 characters
 * after the `or_live_` marker (`prefix`) so people can tell keys apart. A key acts as its org, limited to its scopes.
 */
import { desc, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { hashToken, randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { scoped } from "@/lib/data/tenant";
import { apiKeys, orgs } from "@/lib/db/schema";

export const API_KEY_MARKER = "or_live_";
/** `or_live_` followed by exactly 32 bytes of base64url (43 characters, no padding). */
export const API_KEY_PATTERN = /^or_live_[A-Za-z0-9_-]{43}$/;
export const API_KEY_PREFIX_LENGTH = 8;

export const API_SCOPES = [
  "repos:read",
  "repos:write",
  "reviews:read",
  "reviews:write",
  "findings:read",
  "findings:write",
  "rules:read",
  "rules:write",
  "knowledge:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_LABEL: Record<ApiScope, string> = {
  "repos:read": "Read repositories and index status",
  "repos:write": "Re-index repositories",
  "reviews:read": "Read reviews, runs, and summaries",
  "reviews:write": "Request and cancel reviews",
  "findings:read": "Read findings and fix prompts",
  "findings:write": "Give feedback on findings",
  "rules:read": "Read review rules",
  "rules:write": "Create, edit, and delete review rules",
  "knowledge:read": "Read the knowledge base",
};

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && (API_SCOPES as readonly string[]).includes(value);
}

export const apiKeyInputSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(100, "Names are at most 100 characters."),
  scopes: z
    .array(z.enum(API_SCOPES))
    .min(1, "Choose at least one scope.")
    .transform((s) => API_SCOPES.filter((x) => s.includes(x))),
  /** Days until the key expires; null = never. */
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
});
export type ApiKeyInput = z.input<typeof apiKeyInputSchema>;

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/** What the dashboard and `/api/v1/me` show about a key: never the token or its hash. */
export interface ApiKeySummary {
  id: number;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdBy: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

function summarize(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.filter(isApiScope),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/** How a key is displayed: `or_live_abcd1234…`. */
export function displayKey(prefix: string): string {
  return `${API_KEY_MARKER}${prefix}…`;
}

/** A fresh token and what is stored for it. */
export function generateApiToken(): { token: string; prefix: string; tokenHash: string } {
  const secret = randomToken(32);
  const token = `${API_KEY_MARKER}${secret}`;
  return { token, prefix: secret.slice(0, API_KEY_PREFIX_LENGTH), tokenHash: hashToken(token) };
}

export class ApiKeyValidationError extends Error {}

/** Creates a key for `orgId`. The returned `token` is the only copy of the secret: show it once, never log it. */
export async function createApiKey(
  db: Db,
  input: { orgId: string; createdBy: string | null; now?: Date } & ApiKeyInput,
): Promise<{ key: ApiKeySummary; token: string }> {
  const parsed = apiKeyInputSchema.safeParse({ name: input.name, scopes: input.scopes, expiresInDays: input.expiresInDays });
  if (!parsed.success) throw new ApiKeyValidationError(parsed.error.issues[0]?.message ?? "Invalid API key.");
  const now = input.now ?? new Date();
  const { token, prefix, tokenHash } = generateApiToken();
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: input.orgId,
      name: parsed.data.name,
      prefix,
      tokenHash,
      scopes: parsed.data.scopes,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: parsed.data.expiresInDays === null ? null : new Date(now.getTime() + parsed.data.expiresInDays * 86_400_000),
    })
    .returning();
  return { key: summarize(row!), token };
}

/** The org's keys, newest first (revoked ones included, so the history stays visible). */
export async function listApiKeys(db: Db, orgId: string): Promise<ApiKeySummary[]> {
  const rows = await db.select().from(apiKeys).where(scoped(apiKeys, orgId)).orderBy(desc(apiKeys.createdAt), desc(apiKeys.id)).limit(200);
  return rows.map(summarize);
}

/** Revokes one of the org's keys. Returns the key, or undefined when it is not the org's or was already revoked. */
export async function revokeApiKey(db: Db, orgId: string, keyId: number, now: Date = new Date()): Promise<ApiKeySummary | undefined> {
  if (!Number.isSafeInteger(keyId)) return undefined;
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(scoped(apiKeys, orgId, eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning();
  return row ? summarize(row) : undefined;
}

/** A key that authenticated a request, with its org. */
export interface AuthenticatedKey extends ApiKeySummary {
  orgId: string;
  orgName: string;
  orgSlug: string;
}

export type KeyAuthResult = { ok: true; key: AuthenticatedKey } | { ok: false; reason: "malformed" | "unknown" | "revoked" | "expired" };

/** `lastUsedAt` is written at most once a minute per key, so busy keys do not write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** Resolves a bearer token to its key. Only well-formed, known, unrevoked, unexpired keys authenticate. */
export async function authenticateApiKey(db: Db, token: string, now: Date = new Date()): Promise<KeyAuthResult> {
  if (!API_KEY_PATTERN.test(token)) return { ok: false, reason: "malformed" };
  const [row] = await db
    .select({ key: apiKeys, orgName: orgs.name, orgSlug: orgs.slug })
    .from(apiKeys)
    .innerJoin(orgs, eq(orgs.id, apiKeys.orgId))
    .where(eq(apiKeys.tokenHash, hashToken(token)));
  if (!row) return { ok: false, reason: "unknown" };
  if (row.key.revokedAt) return { ok: false, reason: "revoked" };
  if (row.key.expiresAt && row.key.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(
      scoped(
        apiKeys,
        row.key.orgId,
        eq(apiKeys.id, row.key.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS))),
      ),
    );
  return { ok: true, key: { ...summarize(row.key), orgId: row.key.orgId, orgName: row.orgName, orgSlug: row.orgSlug } };
}

/** Whether a key is usable at `now` (for display). */
export function keyState(key: Pick<ApiKeySummary, "revokedAt" | "expiresAt">, now: Date = new Date()): "active" | "revoked" | "expired" {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}
