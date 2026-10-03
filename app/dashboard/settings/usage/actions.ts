"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { UsageFormState } from "@/components/usage/UsageLimitsForm";
import { requireOrg } from "@/lib/auth";
import { billingConfig } from "@/lib/billing/plans";
import { lazyStripe } from "@/lib/billing/report";
import { parseUsageSettingsForm, rotateAlertSecret, saveUsageSettings, UsageSettingsError } from "@/lib/billing/settings";
import { BillingError, openCustomerPortal, startCheckout } from "@/lib/billing/subscriptions";
import { recordAudit } from "@/lib/data/audit";
import { db } from "@/lib/db";
import { errorMessage, log } from "@/lib/log";
import { withToast } from "@/lib/ui/toast";

const PATH = "/dashboard/settings/usage";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/** Saves the org's usage caps and alerts (R4.3). Requires `settings.manage` (owners and admins). */
export async function saveUsageLimitsAction(_prev: UsageFormState, formData: FormData): Promise<UsageFormState> {
  const { orgId, userId } = await requireOrg({ permission: "settings.manage" });
  const parsed = parseUsageSettingsForm(formData);
  if (!parsed.ok) return { error: parsed.error };
  try {
    const { settings } = await saveUsageSettings(db(), { orgId, userId }, parsed.input, { allowPrivate: billingConfig().allowPrivateAlertUrls });
    await recordAudit(db(), {
      orgId,
      actorType: "user",
      actorId: userId,
      action: "usage_settings.updated",
      targetType: "org",
      targetId: orgId,
      metadata: {
        monthlyCreditCap: settings.monthlyCreditCap,
        monthlyCostCapUsd: settings.monthlyCostCapUsd,
        alertThresholds: settings.alertThresholds,
        alertWebhook: Boolean(settings.alertWebhookUrl),
      },
      ip: await clientIp(),
    });
  } catch (err) {
    if (err instanceof UsageSettingsError) return { error: err.message };
    throw err;
  }
  revalidatePath(PATH);
  return { saved: true };
}

/** Replaces the alert webhook's signing secret (R4.3). Requires `settings.manage`. */
export async function rotateAlertSecretAction() {
  const { orgId, userId } = await requireOrg({ permission: "settings.manage" });
  const secret = await rotateAlertSecret(db(), orgId);
  if (secret) {
    await recordAudit(db(), { orgId, actorType: "user", actorId: userId, action: "usage_settings.secret_rotated", targetType: "org", targetId: orgId, ip: await clientIp() });
  }
  revalidatePath(PATH);
  redirect(withToast(PATH, secret ? "usage.secret_rotated" : "usage.invalid"));
}

/** Sends an owner to Stripe Checkout for the team plan (R4.2). Requires `billing.manage`. */
export async function startCheckoutAction() {
  const { orgId, orgName, userId, user } = await requireOrg({ permission: "billing.manage" });
  const cfg = billingConfig();
  let url: string | null = null;
  let toast: "billing.unavailable" | "billing.already_subscribed" = "billing.unavailable";
  try {
    ({ url } = await startCheckout({ db: db(), cfg, stripe: lazyStripe(cfg), log }, { orgId, orgName, email: user.email }));
    await recordAudit(db(), { orgId, actorType: "user", actorId: userId, action: "billing.checkout_started", targetType: "org", targetId: orgId, ip: await clientIp() });
  } catch (err) {
    log.warn("could not start checkout", { orgId, error: errorMessage(err) });
    if (err instanceof BillingError) toast = "billing.already_subscribed";
  }
  if (url) redirect(url);
  redirect(withToast(PATH, toast));
}

/** Opens the Stripe Customer Portal (R4.2). Requires `billing.manage`. */
export async function openPortalAction() {
  const { orgId } = await requireOrg({ permission: "billing.manage" });
  const cfg = billingConfig();
  let url: string | null = null;
  try {
    url = await openCustomerPortal({ db: db(), cfg, stripe: lazyStripe(cfg), log }, orgId);
  } catch (err) {
    log.warn("could not open the billing portal", { orgId, error: errorMessage(err) });
  }
  if (url) redirect(url);
  redirect(withToast(PATH, "billing.unavailable"));
}
