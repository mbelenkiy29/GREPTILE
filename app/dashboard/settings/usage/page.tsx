import type { Metadata } from "next";
import { BillingSettingsView } from "@/components/usage/BillingSettingsView";
import { UsageLimitsForm } from "@/components/usage/UsageLimitsForm";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { loadBillingSettings } from "@/lib/billing/view";
import { db } from "@/lib/db";
import { openPortalAction, rotateAlertSecretAction, saveUsageLimitsAction, startCheckoutAction } from "./actions";

export const metadata: Metadata = { title: "Usage & billing" };

/** Settings → Usage & billing (R4.3, R4.2). Everyone sees the plan and limits; admins edit caps, owners manage billing. */
export default async function UsageBillingSettingsPage() {
  const { orgId, role } = await requireOrg();
  const canManage = can(role, "settings.manage");
  const view = await loadBillingSettings(db(), orgId, { withSecret: canManage });
  return (
    <BillingSettingsView
      {...view}
      canManage={canManage}
      canBill={can(role, "billing.manage")}
      limitsForm={<UsageLimitsForm action={saveUsageLimitsAction} values={view.settings} />}
      actions={{ checkout: startCheckoutAction, portal: openPortalAction, rotateSecret: rotateAlertSecretAction }}
    />
  );
}
