/**
 * Usage enforcement (R4.3 caps, R4.2 free plan). {@link checkUsageLimits} is consulted before work that spends model
 * tokens starts: review requests (`requestReview`, and again when the review job starts), chat answers, and knowledge
 * refreshes. It turns work away when
 *
 * - the org's hard caps for the period are reached (`usage.monthlyCreditCap`, `usage.monthlyCostCapUsd`), or
 * - (Stripe on, free plan) the plan's included credits are used up, or a review is for a pull request author other
 *   than the period's one active developer.
 *
 * Without Stripe there is no plan limit; caps still apply. Reaching a cap stops new work only: work already running
 * finishes.
 */
import type { Db } from "@/lib/db";
import { activeDevelopers, periodTotals } from "@/lib/data/usage";
import { orgBilling, type OrgBilling, type UsagePeriod } from "./account";
import { billingConfig, type BillingConfig } from "./plans";
import { getUsageSettings } from "./settings";

export type LimitCode = "usage_cap" | "free_plan";

export type UsageVerdict = { ok: true; period: UsagePeriod } | { ok: false; code: LimitCode; reason: string; period: UsagePeriod };

/** Work refused by a usage limit (manual, API, CLI, and mention requests surface the message as is). */
export class UsageLimitError extends Error {
  constructor(
    readonly code: LimitCode,
    message: string,
    readonly period: UsagePeriod,
  ) {
    super(message);
    this.name = "UsageLimitError";
  }
}

export interface LimitDeps {
  cfg?: BillingConfig;
  now?: () => Date;
}

const day = (d: Date) => new Date(d.getTime() - 1).toISOString().slice(0, 10);
const usd = (v: number) => `$${v.toFixed(2)}`;

/**
 * Whether new work of `kind` may start for the org now. Reviews pass the pull request `author` (when known) so the
 * free plan's one-active-developer rule can apply.
 */
export async function checkUsageLimits(
  db: Db,
  orgId: string,
  input: { kind: "review" | "chat" | "knowledge"; author?: string | null },
  deps: LimitDeps = {},
): Promise<UsageVerdict> {
  const cfg = deps.cfg ?? billingConfig();
  const now = deps.now?.() ?? new Date();
  const [billing, settings] = await Promise.all([orgBilling(db, orgId, { cfg, now }), getUsageSettings(db, orgId)]);
  const { period } = billing;
  const capped = settings.monthlyCreditCap !== null || settings.monthlyCostCapUsd !== null;
  const freePlan = billing.plan.id === "free";
  if (!capped && !freePlan) return { ok: true, period };

  const totals = await periodTotals(db, orgId, period);
  const until = `Reviews and answers resume on ${day(period.end)} (UTC) or when an admin raises the cap under Settings → Usage & billing.`;
  if (settings.monthlyCreditCap !== null && totals.credits >= settings.monthlyCreditCap) {
    return {
      ok: false,
      code: "usage_cap",
      period,
      reason: `This organization reached its usage cap of ${settings.monthlyCreditCap} credits for the period (${totals.credits} used). ${until}`,
    };
  }
  if (settings.monthlyCostCapUsd !== null && totals.costUsd >= settings.monthlyCostCapUsd) {
    return {
      ok: false,
      code: "usage_cap",
      period,
      reason: `This organization reached its model cost cap of ${usd(settings.monthlyCostCapUsd)} for the period (${usd(totals.costUsd)} estimated). ${until}`,
    };
  }
  if (freePlan) return freePlanVerdict(db, orgId, billing, totals.credits, input);
  return { ok: true, period };
}

async function freePlanVerdict(db: Db, orgId: string, billing: OrgBilling, credits: number, input: { kind: string; author?: string | null }): Promise<UsageVerdict> {
  const { period, plan } = billing;
  const upgrade = "An owner can upgrade to the team plan under Settings → Usage & billing.";
  if (input.kind !== "review") return { ok: true, period };
  const allowance = billing.includedCredits;
  if (allowance !== null && credits >= allowance) {
    return {
      ok: false,
      code: "free_plan",
      period,
      reason: `The free plan's ${allowance} credits for this period are used up (until ${day(period.end)} UTC). ${upgrade}`,
    };
  }
  const limit = plan.activeDeveloperLimit;
  const author = input.author?.trim();
  if (limit === null || !author) return { ok: true, period };
  const active = await activeDevelopers(db, orgId, period);
  const known = new Set(active.map((a) => a.toLowerCase()));
  if (known.has(author.toLowerCase()) || known.size < limit) return { ok: true, period };
  const who = active.slice(0, limit).map((a) => `@${a}`).join(", ");
  return {
    ok: false,
    code: "free_plan",
    period,
    reason: `The free plan reviews pull requests from ${limit} active developer${limit === 1 ? "" : "s"} per billing period, and ${who} ${limit === 1 ? "is" : "are"} already active this period, so @${author}'s pull request was not reviewed. ${upgrade}`,
  };
}

/** {@link checkUsageLimits}, throwing {@link UsageLimitError} when the work is refused. */
export async function assertWithinUsageLimits(db: Db, orgId: string, input: { kind: "review" | "chat" | "knowledge"; author?: string | null }, deps: LimitDeps = {}): Promise<void> {
  const verdict = await checkUsageLimits(db, orgId, input, deps);
  if (!verdict.ok) throw new UsageLimitError(verdict.code, verdict.reason, verdict.period);
}
