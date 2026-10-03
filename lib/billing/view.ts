/** Data for Settings → Usage & billing (R4.3, R4.2). Reads no billing tables and calls no Stripe API when billing is off. */
import type { Db } from "@/lib/db";
import { activeDevelopers, periodTotals } from "@/lib/data/usage";
import { orgBilling } from "./account";
import { recentUsageAlerts, usageStatus, type UsageMeter } from "./alerts";
import { billingConfig, offeredPlans, type BillingConfig, type Plan } from "./plans";
import { getAlertSecret, getUsageSettings, type UsageSettings } from "./settings";

export interface BillingView {
  /** Stripe billing is configured on this instance. */
  enabled: boolean;
  plan: Plan;
  status: string;
  seats: number;
  period: { start: Date; end: Date };
  includedCredits: number | null;
  creditsUsed: number;
  activeDevelopers: number;
  paymentFailedAt: Date | null;
  cancelAt: Date | null;
  hasCustomer: boolean;
  /** Plans offered (free and team with Stripe; self-hosted otherwise). */
  offered: Plan[];
}

export interface AlertHistoryItem {
  id: number;
  metric: string;
  threshold: number;
  createdAt: Date;
  deliveredAt: Date | null;
  error: string | null;
}

export interface BillingSettingsData {
  billing: BillingView;
  settings: UsageSettings;
  meters: UsageMeter[];
  alerts: AlertHistoryItem[];
  secret: string | null;
}

export async function loadBillingSettings(db: Db, orgId: string, opts: { withSecret: boolean; cfg?: BillingConfig; now?: Date }): Promise<BillingSettingsData> {
  const cfg = opts.cfg ?? billingConfig();
  const now = opts.now ?? new Date();
  const billing = await orgBilling(db, orgId, { cfg, now });
  const [settings, status, totals, developers, alerts, secret] = await Promise.all([
    getUsageSettings(db, orgId),
    usageStatus(db, orgId, { cfg, now: () => now }),
    periodTotals(db, orgId, billing.period),
    activeDevelopers(db, orgId, billing.period),
    recentUsageAlerts(db, orgId, new Date(now.getTime() - 90 * 86_400_000)),
    opts.withSecret ? getAlertSecret(db, orgId) : Promise.resolve(null),
  ]);
  return {
    billing: {
      enabled: cfg.enabled,
      plan: billing.plan,
      status: billing.account?.status ?? "none",
      seats: billing.seats,
      period: billing.period,
      includedCredits: billing.includedCredits,
      creditsUsed: totals.credits,
      activeDevelopers: developers.length,
      paymentFailedAt: billing.account?.paymentFailedAt ?? null,
      cancelAt: billing.account?.cancelAt ?? null,
      hasCustomer: Boolean(billing.account?.stripeCustomerId),
      offered: offeredPlans(cfg),
    },
    settings,
    // Meters other than the plan allowance (that one is on the plan card).
    meters: status.meters.filter((m) => m.metric !== "included"),
    alerts: alerts.map((a) => ({ id: a.id, metric: a.metric, threshold: a.threshold, createdAt: a.createdAt, deliveredAt: a.deliveredAt, error: a.error })),
    secret,
  };
}
