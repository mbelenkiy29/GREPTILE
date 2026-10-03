"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { createApiKeyAudited, parseApiKeyForm, revokeApiKeyAudited } from "@/lib/api/key-admin";
import { displayKey } from "@/lib/api/keys";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { withToast } from "@/lib/ui/toast";

const PATH = "/dashboard/settings/api-keys";

export interface CreateKeyState {
  /** The new key's token: shown once, never stored. */
  token?: string;
  name?: string;
  display?: string;
  error?: string;
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/** Creates an API key (R6.18) and returns its token once. Requires `apikeys.manage`. */
export async function createApiKeyAction(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const { orgId, userId } = await requireOrg({ permission: "apikeys.manage" });
  const parsed = parseApiKeyForm(formData);
  if (!parsed.ok) return { error: parsed.error };
  const { key, token } = await createApiKeyAudited(db(), { orgId, userId, ip: await clientIp() }, parsed.input);
  log.info("API key created", { orgId, keyId: key.id, prefix: key.prefix, scopes: key.scopes, createdBy: userId });
  revalidatePath(PATH);
  return { token, name: key.name, display: displayKey(key.prefix) };
}

/** Revokes an API key (R6.18). Requires `apikeys.manage`. */
export async function revokeApiKeyAction(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "apikeys.manage" });
  const keyId = Number(formData.get("keyId"));
  const key = Number.isSafeInteger(keyId) ? await revokeApiKeyAudited(db(), { orgId, userId, ip: await clientIp() }, keyId) : undefined;
  if (key) log.info("API key revoked", { orgId, keyId: key.id, prefix: key.prefix, revokedBy: userId });
  revalidatePath(PATH);
  redirect(withToast(PATH, key ? "apikey.revoked" : "apikey.not_found"));
}
