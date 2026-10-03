/**
 * Usage caps and alert settings (R4.3), stored per org in `usage_settings`. The alert webhook URL is checked against
 * the SSRF guard when it is saved and again before every delivery (DNS can change in between); its HMAC signing
 * secret is generated here, encrypted at rest, and shown only to people who manage settings.
 */
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret, randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { usageSettings } from "@/lib/db/schema";
import { isNonPublicAddress, resolveHost, type HostResolver } from "@/lib/llm/endpoint-guard";

export const DEFAULT_ALERT_THRESHOLDS = [50, 80, 100] as const;

export interface UsageSettings {
  monthlyCreditCap: number | null;
  monthlyCostCapUsd: number | null;
  /** Percentages of each limit, ascending. */
  alertThresholds: number[];
  alertWebhookUrl: string | null;
  hasAlertSecret: boolean;
  updatedAt: Date | null;
}

export class UsageSettingsError extends Error {}

/** Settings as stored (secret still sealed), or the defaults when the org never saved any. */
export async function getUsageSettingsRow(db: Db, orgId: string) {
  if (!orgId) throw new Error("tenant scope requires an orgId");
  const [row] = await db.select().from(usageSettings).where(eq(usageSettings.orgId, orgId));
  return row ?? null;
}

export async function getUsageSettings(db: Db, orgId: string): Promise<UsageSettings> {
  const row = await getUsageSettingsRow(db, orgId);
  return {
    monthlyCreditCap: row?.monthlyCreditCap ?? null,
    monthlyCostCapUsd: row?.monthlyCostCapUsd ?? null,
    alertThresholds: row ? [...row.alertThresholds].sort((a, b) => a - b) : [...DEFAULT_ALERT_THRESHOLDS],
    alertWebhookUrl: row?.alertWebhookUrl ?? null,
    hasAlertSecret: Boolean(row?.alertWebhookSecret),
    updatedAt: row?.updatedAt ?? null,
  };
}

/** The alert webhook's signing secret in clear text, for display to settings managers and for signing. */
export async function getAlertSecret(db: Db, orgId: string): Promise<string | null> {
  const row = await getUsageSettingsRow(db, orgId);
  return row?.alertWebhookSecret ? decryptSecret(row.alertWebhookSecret) : null;
}

const optionalInt = z.preprocess((v) => (v === "" || v === null || v === undefined ? null : Number(v)), z.number().int().min(0).max(100_000_000).nullable());
const optionalUsd = z.preprocess((v) => (v === "" || v === null || v === undefined ? null : Number(v)), z.number().min(0).max(10_000_000).nullable());

export const usageSettingsInput = z.object({
  monthlyCreditCap: optionalInt,
  monthlyCostCapUsd: optionalUsd.transform((v) => (v === null ? null : Math.round(v * 100) / 100)),
  alertThresholds: z
    .array(z.number().int().min(1).max(1000))
    .max(10)
    .transform((list) => [...new Set(list)].sort((a, b) => a - b)),
  alertWebhookUrl: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v), z.string().max(2048).nullable()),
});
export type UsageSettingsInput = z.infer<typeof usageSettingsInput>;

/** Parses the settings form: thresholds come as a comma-separated list of percentages. */
export function parseUsageSettingsForm(form: FormData): { ok: true; input: UsageSettingsInput } | { ok: false; error: string } {
  const thresholdsRaw = String(form.get("alertThresholds") ?? "").trim();
  const thresholds = thresholdsRaw ? thresholdsRaw.split(/[\s,]+/).filter(Boolean).map((s) => Number(s.replace(/%$/, ""))) : [];
  const parsed = usageSettingsInput.safeParse({
    monthlyCreditCap: form.get("monthlyCreditCap") ?? "",
    monthlyCostCapUsd: form.get("monthlyCostCapUsd") ?? "",
    alertThresholds: thresholds,
    alertWebhookUrl: form.get("alertWebhookUrl") ?? "",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "");
    const label: Record<string, string> = {
      monthlyCreditCap: "The credit cap must be a whole number of credits (or empty for no cap).",
      monthlyCostCapUsd: "The cost cap must be an amount in USD (or empty for no cap).",
      alertThresholds: "Alert thresholds must be up to 10 whole percentages between 1 and 1000, e.g. 50, 80, 100.",
      alertWebhookUrl: "The alert webhook URL is too long.",
    };
    return { ok: false, error: label[field] ?? issue?.message ?? "Check the form." };
  }
  return { ok: true, input: parsed.data };
}

/**
 * SSRF guard for alert webhook URLs: https (http only when private URLs are allowed), no credentials, and a host
 * that is not, and does not resolve to, a loopback / private / link-local / metadata address. Throws
 * {@link UsageSettingsError} with a message fit for the settings form.
 */
export async function assertPublicWebhookUrl(raw: string, opts: { allowPrivate: boolean; resolve?: HostResolver }): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageSettingsError("The alert webhook URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(opts.allowPrivate && url.protocol === "http:")) {
    throw new UsageSettingsError("The alert webhook URL must use https.");
  }
  if (url.username || url.password) throw new UsageSettingsError("The alert webhook URL must not contain credentials.");
  if (opts.allowPrivate) return url;
  const host = (url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname).toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new UsageSettingsError("The alert webhook URL must not point at a local address.");
  const nonPublic = "The alert webhook URL must not point at a private, loopback, or link-local address.";
  if (isIP(host)) {
    if (isNonPublicAddress(host)) throw new UsageSettingsError(nonPublic);
    return url;
  }
  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? resolveHost)(host);
  } catch {
    throw new UsageSettingsError(`The alert webhook host ${host} could not be resolved.`);
  }
  if (!addresses.length) throw new UsageSettingsError(`The alert webhook host ${host} has no addresses.`);
  if (addresses.some(isNonPublicAddress)) throw new UsageSettingsError(nonPublic);
  return url;
}

/**
 * Validates and stores an org's caps and alert settings. Setting a webhook URL for the first time generates its
 * signing secret (returned once as `newSecret`); clearing the URL drops the secret.
 */
export async function saveUsageSettings(
  db: Db,
  ctx: { orgId: string; userId: string | null },
  input: UsageSettingsInput,
  opts: { allowPrivate: boolean; resolve?: HostResolver },
): Promise<{ settings: UsageSettings; newSecret: string | null }> {
  if (!ctx.orgId) throw new Error("tenant scope requires an orgId");
  const parsed = usageSettingsInput.parse(input);
  if (parsed.alertWebhookUrl) await assertPublicWebhookUrl(parsed.alertWebhookUrl, opts);
  const current = await getUsageSettingsRow(db, ctx.orgId);
  let sealed = parsed.alertWebhookUrl ? (current?.alertWebhookSecret ?? null) : null;
  let newSecret: string | null = null;
  if (parsed.alertWebhookUrl && !sealed) {
    newSecret = `orwh_${randomToken(24)}`;
    sealed = encryptSecret(newSecret);
  }
  const values = {
    monthlyCreditCap: parsed.monthlyCreditCap,
    monthlyCostCapUsd: parsed.monthlyCostCapUsd,
    alertThresholds: parsed.alertThresholds,
    alertWebhookUrl: parsed.alertWebhookUrl,
    alertWebhookSecret: sealed,
    updatedBy: ctx.userId,
  };
  await db
    .insert(usageSettings)
    .values({ orgId: ctx.orgId, ...values })
    .onConflictDoUpdate({ target: usageSettings.orgId, set: { ...values, updatedAt: new Date() } });
  return { settings: await getUsageSettings(db, ctx.orgId), newSecret };
}

/** Replaces the alert webhook's signing secret; returns the new one (or null when no webhook is set). */
export async function rotateAlertSecret(db: Db, orgId: string): Promise<string | null> {
  const row = await getUsageSettingsRow(db, orgId);
  if (!row?.alertWebhookUrl) return null;
  const secret = `orwh_${randomToken(24)}`;
  await db.update(usageSettings).set({ alertWebhookSecret: encryptSecret(secret), updatedAt: new Date() }).where(eq(usageSettings.orgId, orgId));
  return secret;
}
