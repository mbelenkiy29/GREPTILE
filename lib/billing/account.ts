/**
 * An org's plan and usage period (R4.2, R4.3). Without Stripe every org is on the unlimited self-hosted plan and its
 * usage period is the UTC calendar month. With Stripe, an org with a paid subscription in force is on the team plan
 * and its period is the subscription's current period; every other org is on the free plan (calendar month).
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { billingAccounts } from "@/lib/db/schema";
import { monthStart } from "@/lib/data/usage";
import { billingConfig, includedCredits, PAID_STATUSES, type BillingConfig, type Plan } from "./plans";

export type BillingAccount = typeof billingAccounts.$inferSelect;

export interface UsagePeriod {
  start: Date;
  /** Exclusive. */
  end: Date;
}

export interface OrgBilling {
  plan: Plan;
  /** The org's Stripe mirror row (null without Stripe or before the org first opened checkout). */
  account: BillingAccount | null;
  period: UsagePeriod;
  /** Paid seats (team plan); 0 otherwise. */
  seats: number;
  /** Credits included this period; null = unlimited. */
  includedCredits: number | null;
}

/** The UTC calendar month containing `now`. */
export function calendarPeriod(now: Date): UsagePeriod {
  return { start: monthStart(now), end: monthStart(now, 1) };
}

/** Whether the account's paid subscription is in force (team plan). */
export function hasPaidPlan(account: Pick<BillingAccount, "plan" | "status"> | null | undefined): boolean {
  return Boolean(account && account.plan === "team" && PAID_STATUSES.has(account.status));
}

/** The usage period: the subscription's current period when it covers `now`, otherwise the calendar month. */
export function usagePeriod(account: Pick<BillingAccount, "plan" | "status" | "currentPeriodStart" | "currentPeriodEnd"> | null | undefined, now: Date): UsagePeriod {
  if (hasPaidPlan(account) && account!.currentPeriodStart && account!.currentPeriodEnd && account!.currentPeriodStart <= now && now < account!.currentPeriodEnd) {
    return { start: account!.currentPeriodStart, end: account!.currentPeriodEnd };
  }
  return calendarPeriod(now);
}

export async function getBillingAccount(db: Db, orgId: string): Promise<BillingAccount | null> {
  if (!orgId) throw new Error("tenant scope requires an orgId");
  const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
  return row ?? null;
}

/** The org's plan, period, and allowance. Reads no billing rows at all when Stripe is not configured. */
export async function orgBilling(db: Db, orgId: string, opts: { cfg?: BillingConfig; now?: Date } = {}): Promise<OrgBilling> {
  const cfg = opts.cfg ?? billingConfig();
  const now = opts.now ?? new Date();
  if (!cfg.enabled) {
    return { plan: cfg.plans.self_hosted, account: null, period: calendarPeriod(now), seats: 0, includedCredits: null };
  }
  const account = await getBillingAccount(db, orgId);
  const paid = hasPaidPlan(account);
  const plan = paid ? cfg.plans.team : cfg.plans.free;
  const seats = paid ? Math.max(1, account!.seats) : 0;
  return { plan, account, period: usagePeriod(account, now), seats, includedCredits: includedCredits(plan, seats) };
}
