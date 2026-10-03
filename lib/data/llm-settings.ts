/**
 * Bring-your-own model provider per org (R4.6): provider, base URL, API key (encrypted with lib/crypto, never shown
 * again after saving), default model, and per-task models. Base URLs pass the SSRF guard when saved and again when
 * calls are made (the gateway re-checks), unless the operator allows private endpoints.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { orgLlmSettings } from "@/lib/db/schema";
import { llmEnvSchema } from "@/lib/env";
import { assertPublicOrgEndpoint, type HostResolver } from "@/lib/llm/endpoint-guard";
import type { OrgLlmOverride } from "@/lib/llm/routing";
import type { ChatTask } from "@/lib/llm/types";
import { errorMessage } from "@/lib/log";
import { auditUserAction, type UserActor } from "./audit";

export const ORG_LLM_PROVIDERS = ["anthropic", "openai", "openrouter", "openai-compatible"] as const;
export type OrgLlmProvider = (typeof ORG_LLM_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<OrgLlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI-compatible (vLLM, Ollama, LM Studio, gateways)",
};

/** Tasks an org may route to its own model, in the order the settings form lists them. */
export const TASK_MODEL_TASKS: readonly { task: ChatTask; label: string }[] = [
  { task: "review", label: "Review" },
  { task: "verify", label: "Verification" },
  { task: "summary", label: "Summaries" },
  { task: "classify", label: "Classification" },
  { task: "context", label: "Context selection" },
  { task: "chat", label: "Conversations" },
  { task: "knowledge", label: "Knowledge base" },
  { task: "rules", label: "Rule mining" },
];

export type OrgLlmSettingsRow = typeof orgLlmSettings.$inferSelect;

/** What the settings page shows: never the key, only whether one is stored. */
export interface OrgLlmSettingsView {
  provider: OrgLlmProvider;
  baseUrl: string | null;
  model: string | null;
  taskModels: Partial<Record<ChatTask, string>>;
  hasApiKey: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

export class LlmSettingsError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "LlmSettingsError";
  }
}

const modelName = z
  .string()
  .trim()
  .max(200, "Model names are at most 200 characters.")
  .regex(/^[\w.:/@+-]*$/, "Model names may contain letters, digits, and . : / @ + - _ only.");

export interface LlmSettingsInput {
  provider: OrgLlmProvider;
  baseUrl: string | null;
  /** New key; undefined keeps the stored one. */
  apiKey?: string;
  /** Remove the stored key. */
  clearApiKey: boolean;
  model: string | null;
  taskModels: Partial<Record<ChatTask, string>>;
}

/** Parses the settings form (untrusted). Throws LlmSettingsError with the offending field. */
export function parseLlmSettingsForm(form: FormData): LlmSettingsInput {
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const provider = str("provider");
  if (!(ORG_LLM_PROVIDERS as readonly string[]).includes(provider)) throw new LlmSettingsError("Pick a provider.", "provider");
  const baseUrl = str("baseUrl");
  if (baseUrl.length > 2048) throw new LlmSettingsError("The base URL is too long.", "baseUrl");
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    } catch {
      throw new LlmSettingsError("The base URL must be an https URL.", "baseUrl");
    }
  }
  const apiKey = str("apiKey");
  if (apiKey.length > 4096) throw new LlmSettingsError("The API key is too long.", "apiKey");
  const parseModel = (field: string) => {
    const r = modelName.safeParse(str(field));
    if (!r.success) throw new LlmSettingsError(r.error.issues[0]?.message ?? "Invalid model name.", field);
    return r.data || null;
  };
  const model = parseModel("model");
  const taskModels: Partial<Record<ChatTask, string>> = {};
  for (const { task } of TASK_MODEL_TASKS) {
    const m = parseModel(`taskModel.${task}`);
    if (m) taskModels[task] = m;
  }
  const p = provider as OrgLlmProvider;
  if (p === "openai-compatible" && !baseUrl) throw new LlmSettingsError("An OpenAI-compatible provider needs a base URL.", "baseUrl");
  if (p !== "anthropic" && !model) throw new LlmSettingsError(`Pick a default model for ${PROVIDER_LABEL[p]}.`, "model");
  return { provider: p, baseUrl: baseUrl ? baseUrl.replace(/\/+$/, "") : null, ...(apiKey ? { apiKey } : {}), clearApiKey: form.get("clearApiKey") === "on", model, taskModels };
}

export async function getOrgLlmSettings(db: Db, orgId: string): Promise<OrgLlmSettingsRow | undefined> {
  const [row] = await db.select().from(orgLlmSettings).where(eq(orgLlmSettings.orgId, orgId));
  return row;
}

export function toLlmSettingsView(row: OrgLlmSettingsRow): OrgLlmSettingsView {
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    taskModels: row.taskModels as Partial<Record<ChatTask, string>>,
    hasApiKey: Boolean(row.apiKeyEnc),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export async function getOrgLlmSettingsView(db: Db, orgId: string): Promise<OrgLlmSettingsView | null> {
  const row = await getOrgLlmSettings(db, orgId);
  return row ? toLlmSettingsView(row) : null;
}

/** The org's override for the model gateway, with the key decrypted; null when the org uses the operator's model. */
export function overrideFromRow(row: OrgLlmSettingsRow): OrgLlmOverride {
  return {
    provider: row.provider,
    ...(row.model ? { model: row.model } : {}),
    ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
    ...(row.apiKeyEnc ? { apiKey: decryptSecret(row.apiKeyEnc) } : {}),
    taskModels: row.taskModels as Partial<Record<ChatTask, string>>,
  };
}

export async function loadOrgLlmOverride(db: Db, orgId: string): Promise<OrgLlmOverride | null> {
  const row = await getOrgLlmSettings(db, orgId);
  return row ? overrideFromRow(row) : null;
}

/** The SSRF guard for an org's base URL; the operator's own LLM_BASE_URL is trusted as is. */
export async function assertOrgBaseUrl(baseUrl: string | null, opts: { env?: Record<string, string | undefined>; resolve?: HostResolver } = {}): Promise<void> {
  if (!baseUrl) return;
  const e = llmEnvSchema.parse(opts.env ?? process.env);
  if (e.LLM_BASE_URL && baseUrl === e.LLM_BASE_URL.replace(/\/+$/, "")) return;
  try {
    await assertPublicOrgEndpoint(baseUrl, { allowPrivate: e.LLM_ALLOW_PRIVATE_ORG_ENDPOINTS, resolve: opts.resolve });
  } catch (err) {
    throw new LlmSettingsError(errorMessage(err), "baseUrl");
  }
}

/** Saves the org's settings (validated and SSRF-checked) and records `llm_settings.updated`. */
export async function saveOrgLlmSettings(
  db: Db,
  actor: UserActor,
  input: LlmSettingsInput,
  opts: { env?: Record<string, string | undefined>; resolve?: HostResolver } = {},
): Promise<OrgLlmSettingsView> {
  await assertOrgBaseUrl(input.baseUrl, opts);
  const existing = await getOrgLlmSettings(db, actor.orgId);
  const apiKeyEnc = input.apiKey ? encryptSecret(input.apiKey) : input.clearApiKey ? null : (existing?.apiKeyEnc ?? null);
  // A key is only kept for the endpoint it was entered for: changing provider or base URL without a new key drops it.
  const endpointChanged = existing && (existing.provider !== input.provider || existing.baseUrl !== input.baseUrl);
  const keptKey = !input.apiKey && endpointChanged ? null : apiKeyEnc;
  const values = {
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiKeyEnc: keptKey,
    model: input.model,
    taskModels: input.taskModels as Record<string, string>,
    updatedBy: actor.userId,
    updatedAt: actor.now ?? new Date(),
  };
  const [row] = await db.insert(orgLlmSettings).values({ orgId: actor.orgId, ...values }).onConflictDoUpdate({ target: orgLlmSettings.orgId, set: values }).returning();
  await auditUserAction(db, actor, {
    action: existing ? "llm_settings.updated" : "llm_settings.created",
    targetType: "org",
    targetId: actor.orgId,
    metadata: {
      provider: input.provider,
      baseUrlHost: input.baseUrl ? new URL(input.baseUrl).host : null,
      model: input.model,
      taskModels: input.taskModels,
      apiKey: input.apiKey ? "changed" : keptKey ? "unchanged" : "none",
    },
  });
  return toLlmSettingsView(row!);
}

/** Removes the org's settings (back to the operator's model) and records `llm_settings.removed`. */
export async function deleteOrgLlmSettings(db: Db, actor: UserActor): Promise<boolean> {
  const rows = await db.delete(orgLlmSettings).where(eq(orgLlmSettings.orgId, actor.orgId)).returning({ orgId: orgLlmSettings.orgId });
  if (rows.length) await auditUserAction(db, actor, { action: "llm_settings.removed", targetType: "org", targetId: actor.orgId });
  return rows.length > 0;
}
