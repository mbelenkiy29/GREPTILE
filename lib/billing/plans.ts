/**
 * Plans (R4.2, R5.2): the single source of truth for what each plan includes and costs. Stripe checkout, usage
 * enforcement, the billing settings page, and the public pricing page all read {@link plans}; nothing else hardcodes
 * a price, an allowance, or a Stripe id. Prices are display values from the environment; Stripe price ids come only
 * from `STRIPE_PRICE_*`.
 */
import { billingEnv, type BillingEnv } from "@/lib/env";

export const PLAN_IDS = ["self_hosted", "free", "team"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price in USD: per seat for `perSeat` plans; 0 for free plans. */
  priceUsd: number;
  perSeat: boolean;
  /** Distinct PR authors reviewed per billing period; null = unlimited. */
  activeDeveloperLimit: number | null;
  /** Credits included per billing period (whole org); null = unlimited or per seat. */
  includedCredits: number | null;
  /** Credits included per seat per billing period (per-seat plans). */
  includedCreditsPerSeat: number | null;
  /** USD per overage credit beyond the included credits; null = no overage (usage stops at the allowance). */
  overagePriceUsd: number | null;
  /** Stripe price ids (only for plans bought through Stripe). */
  stripe: { seatPrice: string; overagePrice: string } | null;
  features: string[];
}

export interface BillingConfig {
  /** Stripe billing is configured (all four STRIPE_* variables). */
  enabled: boolean;
  stripe: { secretKey: string; webhookSecret: string; seatPrice: string; overagePrice: string } | null;
  appUrl: string;
  allowPrivateAlertUrls: boolean;
  plans: Record<PlanId, Plan>;
}

const COMMON = ["Full-codebase context", "Inline review comments and summaries", "Custom rules and learned preferences", "Chat with the reviewer on pull requests"];

/** Billing configuration from the environment: whether Stripe is on and every plan's limits and prices. */
export function billingConfig(env: BillingEnv = billingEnv()): BillingConfig {
  const stripe =
    env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_TEAM_SEAT && env.STRIPE_PRICE_OVERAGE
      ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, seatPrice: env.STRIPE_PRICE_TEAM_SEAT, overagePrice: env.STRIPE_PRICE_OVERAGE }
      : null;
  return {
    enabled: stripe !== null,
    stripe,
    appUrl: env.APP_URL.replace(/\/+$/, ""),
    allowPrivateAlertUrls: env.USAGE_ALERT_ALLOW_PRIVATE_URLS,
    plans: {
      self_hosted: {
        id: "self_hosted",
        name: "Self-hosted",
        tagline: "Run OpenReview on your own server with your own model keys. Unlimited.",
        priceUsd: 0,
        perSeat: false,
        activeDeveloperLimit: null,
        includedCredits: null,
        includedCreditsPerSeat: null,
        overagePriceUsd: null,
        stripe: null,
        features: [...COMMON, "Unlimited developers and reviews", "Your infrastructure, your LLM provider", "AGPL-3.0 source"],
      },
      free: {
        id: "free",
        name: "Free",
        tagline: "For one developer trying OpenReview.",
        priceUsd: 0,
        perSeat: false,
        activeDeveloperLimit: 1,
        includedCredits: env.FREE_MONTHLY_CREDITS,
        includedCreditsPerSeat: null,
        overagePriceUsd: null,
        stripe: null,
        features: [...COMMON, "1 active developer", `${env.FREE_MONTHLY_CREDITS} review credits per month`],
      },
      team: {
        id: "team",
        name: "Team",
        tagline: "For teams: every developer whose pull requests are reviewed is a seat.",
        priceUsd: env.TEAM_SEAT_PRICE_USD,
        perSeat: true,
        activeDeveloperLimit: null,
        includedCredits: null,
        includedCreditsPerSeat: env.TEAM_INCLUDED_CREDITS_PER_SEAT,
        overagePriceUsd: env.OVERAGE_CREDIT_PRICE_USD,
        stripe: stripe ? { seatPrice: stripe.seatPrice, overagePrice: stripe.overagePrice } : null,
        features: [...COMMON, "Unlimited active developers", `${env.TEAM_INCLUDED_CREDITS_PER_SEAT} credits per seat per month`, "Metered overage, usage caps, and alerts"],
      },
    },
  };
}

/** Plans to offer: the hosted plans when Stripe is on, otherwise the self-hosted plan alone (R5.2 pricing reads this). */
export function offeredPlans(cfg: BillingConfig = billingConfig()): Plan[] {
  return cfg.enabled ? [cfg.plans.free, cfg.plans.team] : [cfg.plans.self_hosted];
}

/** Credits included in a billing period for `plan` with `seats` seats; null = unlimited. */
export function includedCredits(plan: Plan, seats: number): number | null {
  if (plan.includedCreditsPerSeat !== null) return plan.includedCreditsPerSeat * Math.max(1, seats);
  return plan.includedCredits;
}

/** Subscription statuses that keep a paid plan in force. `past_due` keeps it while Stripe retries the payment. */
export const PAID_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);
