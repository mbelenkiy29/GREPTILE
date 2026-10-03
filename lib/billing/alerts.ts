/**
 * Usage alerts (R4.3). Each limit an org has (credit cap, cost cap, and with Stripe the plan's included credits) is a
 * meter; crossing one of the org's alert thresholds (percentages of the limit) during a usage period
 *
 * - shows a banner across the dashboard while it stays crossed, and
 * - records a `usage_alerts` row, unique per (org, period, metric, threshold), and, when an alert webhook URL is set,
 *   POSTs it there once, signed with HMAC-SHA256 (`x-openreview-signature: sha256=<hex of HMAC(secret,
 *   "<timestamp>.<body>")>`, `x-openreview-timestamp`). The URL passes the SSRF guard again before each delivery,
 *   redirects are not followed, and a delivery that fails is recorded on the alert, not retried.
 *
 * Alerts are checked after every completed review and hourly by the `report-usage` job.
 */
import { createOutboundFetch } from "@/lib/net/fetch";
import { createHmac } from "node:crypto";
import { and, desc, eq, gte, notInArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { orgs, usageAlerts, usageSettings } from "@/lib/db/schema";
import { isSystemOrg, SYSTEM_ORG_IDS } from "@/lib/demo/ids";
import { periodTotals } from "@/lib/data/usage";
import type { HostResolver } from "@/lib/llm/endpoint-guard";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { orgBilling, type UsagePeriod } from "./account";
import { billingConfig, type BillingConfig } from "./plans";
import { assertPublicWebhookUrl, getAlertSecret, getUsageSettings } from "./settings";

export type MeterId = "credits" | "cost" | "included";

export interface UsageMeter {
  metric: MeterId;
  label: string;
  value: number;
  limit: number;
  /** value / limit, 0.. (above 1 when over). */
  ratio: number;
  /** Whether reaching the limit stops new work (caps, the free plan's allowance) or bills overage (team plan). */
  hard: boolean;
}

export interface UsageStatus {
  period: UsagePeriod;
  thresholds: number[];
  meters: UsageMeter[];
}

export interface AlertDeps {
  cfg?: BillingConfig;
  now?: () => Date;
  fetch?: typeof fetch;
  resolve?: HostResolver;
  log?: Logger;
  /** Per-delivery timeout. */
  timeoutMs?: number;
}

/** The org's meters for the current usage period. */
export async function usageStatus(db: Db, orgId: string, deps: Pick<AlertDeps, "cfg" | "now"> = {}): Promise<UsageStatus> {
  const cfg = deps.cfg ?? billingConfig();
  const now = deps.now?.() ?? new Date();
  const [billing, settings] = await Promise.all([orgBilling(db, orgId, { cfg, now }), getUsageSettings(db, orgId)]);
  const meters: UsageMeter[] = [];
  const hasLimit = settings.monthlyCreditCap !== null || settings.monthlyCostCapUsd !== null || billing.includedCredits !== null;
  if (!hasLimit) return { period: billing.period, thresholds: settings.alertThresholds, meters };
  const totals = await periodTotals(db, orgId, billing.period);
  const meter = (metric: MeterId, label: string, value: number, limit: number, hard: boolean): UsageMeter => ({
    metric,
    label,
    value,
    limit,
    ratio: limit > 0 ? value / limit : value > 0 ? Infinity : 0,
    hard,
  });
  if (settings.monthlyCreditCap !== null) meters.push(meter("credits", "Credit cap", totals.credits, settings.monthlyCreditCap, true));
  if (settings.monthlyCostCapUsd !== null) meters.push(meter("cost", "Model cost cap", totals.costUsd, settings.monthlyCostCapUsd, true));
  if (billing.includedCredits !== null) {
    meters.push(meter("included", `${billing.plan.name} plan included credits`, totals.credits, billing.includedCredits, billing.plan.overagePriceUsd === null));
  }
  return { period: billing.period, thresholds: settings.alertThresholds, meters };
}

export interface UsageBanner {
  tone: "warning" | "error";
  metric: MeterId;
  message: string;
}

const fmt = (m: UsageMeter, v: number) => (m.metric === "cost" ? `$${v.toFixed(2)}` : `${Math.round(v).toLocaleString("en-US")} credits`);

/** Dashboard banners: one per meter at or past the org's lowest alert threshold. */
export function usageBanners(status: UsageStatus): UsageBanner[] {
  const lowest = status.thresholds[0];
  if (lowest === undefined) return [];
  const until = new Date(status.period.end.getTime() - 1).toISOString().slice(0, 10);
  return status.meters
    .filter((m) => m.ratio * 100 >= lowest)
    .map((m) => {
      const pct = Number.isFinite(m.ratio) ? Math.round(m.ratio * 100) : 100;
      const reached = m.ratio >= 1;
      const what = `${m.label}: ${fmt(m, m.value)} of ${fmt(m, m.limit)} used (${pct}%) this period, through ${until} UTC.`;
      const then = reached
        ? m.hard
          ? " New reviews, answers, and knowledge refreshes are paused until the period ends or the limit is raised."
          : " Further usage is billed as overage."
        : "";
      return { tone: reached ? ("error" as const) : ("warning" as const), metric: m.metric, message: `${what}${then}` };
    });
}

/** `sha256=<hex>` HMAC of `<timestamp>.<body>`, the alert webhook's signature header. */
export function signAlertPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface FiredAlert {
  id: number;
  metric: MeterId;
  threshold: number;
  value: number;
  limit: number;
  delivered: boolean | null;
}

/**
 * Records every threshold the org's meters crossed this period that has not fired yet, and delivers each newly fired
 * alert to the org's alert webhook once. Returns the newly fired alerts (`delivered` null when there is no webhook).
 */
export async function checkUsageAlerts(db: Db, orgId: string, deps: AlertDeps = {}): Promise<FiredAlert[]> {
  const cfg = deps.cfg ?? billingConfig();
  const now = deps.now?.() ?? new Date();
  const log = (deps.log ?? rootLog).child({ component: "usage-alerts", orgId });
  const status = await usageStatus(db, orgId, { cfg, now: () => now });
  const fired: FiredAlert[] = [];
  for (const m of status.meters) {
    for (const threshold of status.thresholds) {
      if (m.ratio * 100 < threshold) continue;
      const [row] = await db
        .insert(usageAlerts)
        .values({ orgId, periodStart: status.period.start, metric: m.metric, threshold, value: m.value, limit: m.limit })
        .onConflictDoNothing()
        .returning({ id: usageAlerts.id });
      if (row) fired.push({ id: row.id, metric: m.metric, threshold, value: m.value, limit: m.limit, delivered: null });
    }
  }
  if (!fired.length) return fired;
  log.info("usage alert thresholds crossed", { alerts: fired.map((a) => `${a.metric}@${a.threshold}%`) });

  const [settings] = await db.select({ url: usageSettings.alertWebhookUrl }).from(usageSettings).where(eq(usageSettings.orgId, orgId));
  const secret = settings?.url ? await getAlertSecret(db, orgId) : null;
  if (!settings?.url || !secret) return fired;
  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
  for (const alert of fired) {
    const result = await deliverAlert(settings.url, secret, {
      type: "usage.threshold_reached",
      org: { id: orgId, name: org?.name ?? null },
      metric: alert.metric,
      threshold: alert.threshold,
      value: alert.value,
      limit: alert.limit,
      period: { start: status.period.start.toISOString(), end: status.period.end.toISOString() },
      firedAt: now.toISOString(),
    }, { ...deps, allowPrivate: cfg.allowPrivateAlertUrls, at: now });
    alert.delivered = result.ok;
    await db
      .update(usageAlerts)
      .set(result.ok ? { deliveredAt: now, error: null } : { error: result.error })
      .where(and(eq(usageAlerts.orgId, orgId), eq(usageAlerts.id, alert.id)));
    if (result.ok) log.info("usage alert delivered", { metric: alert.metric, threshold: alert.threshold });
    else log.warn("usage alert delivery failed", { metric: alert.metric, threshold: alert.threshold, error: result.error });
  }
  return fired;
}

async function deliverAlert(
  url: string,
  secret: string,
  payload: Record<string, unknown>,
  deps: AlertDeps & { allowPrivate: boolean; at: Date },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Re-checked at delivery: the host may resolve elsewhere than when the URL was saved.
    await assertPublicWebhookUrl(url, { allowPrivate: deps.allowPrivate, resolve: deps.resolve });
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(deps.at.getTime() / 1000));
    // The org configured this endpoint and it passed the SSRF guard above, so its host is allowed for this call (R4.6).
    const res = await (deps.fetch ?? createOutboundFetch({ allow: [new URL(url).host] }))(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      headers: {
        "content-type": "application/json",
        "user-agent": "OpenReview-Usage-Alerts",
        "x-openreview-event": "usage.threshold_reached",
        "x-openreview-timestamp": timestamp,
        "x-openreview-signature": signAlertPayload(secret, timestamp, body),
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `the webhook answered HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err, 500) };
  }
}

/**
 * Orgs whose alerts need checking on the hourly sweep: any with a cap or a webhook set (all orgs when billing is on).
 * System orgs (the public demo's `org_demo`) are never customers and are skipped.
 */
export async function orgsWithUsageLimits(db: Db, cfg: BillingConfig): Promise<string[]> {
  if (cfg.enabled) return (await db.select({ id: orgs.id }).from(orgs).where(notInArray(orgs.id, [...SYSTEM_ORG_IDS]))).map((o) => o.id);
  const rows = await db.select({ orgId: usageSettings.orgId, credit: usageSettings.monthlyCreditCap, cost: usageSettings.monthlyCostCapUsd }).from(usageSettings);
  return rows.filter((r) => (r.credit !== null || r.cost !== null) && !isSystemOrg(r.orgId)).map((r) => r.orgId);
}

/** Alerts that fired for the org since `since`, newest first (settings page history). */
export async function recentUsageAlerts(db: Db, orgId: string, since: Date, limit = 20) {
  if (!orgId) throw new Error("tenant scope requires an orgId");
  return db
    .select()
    .from(usageAlerts)
    .where(and(eq(usageAlerts.orgId, orgId), gte(usageAlerts.createdAt, since)))
    .orderBy(desc(usageAlerts.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}
