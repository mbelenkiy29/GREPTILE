/**
 * The hourly `report-usage` job (R4.2, R4.3): with Stripe on, seat sync and metered overage reporting for every org
 * with a team subscription; always, usage alert checks for every org that has limits. Every step is idempotent, so a
 * retried or overlapping run never bills or alerts twice.
 */
import type { Db } from "@/lib/db";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { checkUsageAlerts, orgsWithUsageLimits, type AlertDeps } from "./alerts";
import { billingConfig, type BillingConfig } from "./plans";
import { stripeApi, type StripeApi } from "./stripe";
import { syncAllSubscriptions } from "./subscriptions";

export interface ReportUsageDeps {
  db: Db;
  cfg?: BillingConfig;
  /** Stripe client factory; defaults to the real client (created only when billing is on). */
  stripe?: () => StripeApi;
  now?: () => Date;
  log?: Logger;
  alerts?: AlertDeps;
}

export interface ReportUsageResult {
  billing: { orgs: number; failed: number } | null;
  alertOrgs: number;
  alertsFired: number;
}

/** Lazily creates one Stripe client for `cfg` (never when billing is off). */
export function lazyStripe(cfg: BillingConfig): () => StripeApi {
  let client: StripeApi | undefined;
  return () => (client ??= stripeApi(cfg));
}

export async function reportUsage(deps: ReportUsageDeps): Promise<ReportUsageResult> {
  const cfg = deps.cfg ?? billingConfig();
  const log = (deps.log ?? rootLog).child({ component: "report-usage" });
  const billing = cfg.enabled ? await syncAllSubscriptions({ db: deps.db, cfg, stripe: deps.stripe ?? lazyStripe(cfg), now: deps.now, log }) : null;
  const orgIds = await orgsWithUsageLimits(deps.db, cfg);
  let alertsFired = 0;
  for (const orgId of orgIds) {
    try {
      alertsFired += (await checkUsageAlerts(deps.db, orgId, { ...deps.alerts, cfg, ...(deps.now ? { now: deps.now } : {}), log })).length;
    } catch (err) {
      log.warn("usage alert check failed", { orgId, error: errorMessage(err) });
    }
  }
  return { billing, alertOrgs: orgIds.length, alertsFired };
}
