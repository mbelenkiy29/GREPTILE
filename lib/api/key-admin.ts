/**
 * API key management as the dashboard does it (R6.18): the form parsing and the create / revoke operations with
 * their audit entries. Callers must already hold `apikeys.manage` in `orgId` (the server actions check it).
 */
import type { Db } from "@/lib/db";
import { recordAudit } from "@/lib/data/audit";
import { apiKeyInputSchema, createApiKey, revokeApiKey, type ApiKeyInput, type ApiKeySummary } from "./keys";

/** Expiry choices offered by the dashboard (days; "" = never). */
export const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "", label: "Never" },
] as const;

export type KeyFormResult = { ok: true; input: ApiKeyInput } | { ok: false; error: string };

export function parseApiKeyForm(formData: FormData): KeyFormResult {
  const expiry = String(formData.get("expiresInDays") ?? "").trim();
  const parsed = apiKeyInputSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    scopes: formData.getAll("scopes").map(String),
    expiresInDays: expiry === "" ? null : Number(expiry),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  return { ok: true, input: parsed.data };
}

export interface KeyActor {
  orgId: string;
  userId: string;
  ip?: string | null;
  now?: Date;
}

/** Creates a key and records `api_key.created`. Returns the token, which must be shown once and never stored. */
export async function createApiKeyAudited(db: Db, actor: KeyActor, input: ApiKeyInput): Promise<{ key: ApiKeySummary; token: string }> {
  const now = actor.now ?? new Date();
  const created = await createApiKey(db, { orgId: actor.orgId, createdBy: actor.userId, now, ...input });
  await recordAudit(db, {
    orgId: actor.orgId,
    actorType: "user",
    actorId: actor.userId,
    action: "api_key.created",
    targetType: "api_key",
    targetId: created.key.id,
    metadata: { name: created.key.name, prefix: created.key.prefix, scopes: created.key.scopes, expiresAt: created.key.expiresAt?.toISOString() ?? null },
    ip: actor.ip ?? null,
    now,
  });
  return created;
}

/** Revokes one of the org's keys and records `api_key.revoked`. Undefined when there is no such active key. */
export async function revokeApiKeyAudited(db: Db, actor: KeyActor, keyId: number): Promise<ApiKeySummary | undefined> {
  const now = actor.now ?? new Date();
  const key = await revokeApiKey(db, actor.orgId, keyId, now);
  if (!key) return undefined;
  await recordAudit(db, {
    orgId: actor.orgId,
    actorType: "user",
    actorId: actor.userId,
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: key.id,
    metadata: { name: key.name, prefix: key.prefix },
    ip: actor.ip ?? null,
    now,
  });
  return key;
}
