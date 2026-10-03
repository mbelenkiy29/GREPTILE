/**
 * Price calculations for invoices. All amounts are integer cents.
 */

export interface Coupon {
  code: string;
  percentOff: number;
}

/** Most a coupon may take off, unless a plan allows more. */
export const DEFAULT_MAX_PERCENT_OFF = 30;

/**
 * Applies a percentage discount, capped at `maxPercentOff`, never going below zero.
 */
export function applyDiscount(amountCents: number, percentOff: number, maxPercentOff = DEFAULT_MAX_PERCENT_OFF): number {
  const effective = Math.min(percentOff, maxPercentOff);
  if (effective <= 0) return amountCents;
  const discounted = Math.round(amountCents * (1 - effective / 100));
  return Math.max(0, discounted);
}

const TAX_RATES: Record<string, number> = {
  "us-ca": 0.0725,
  "us-ny": 0.04,
  "eu-de": 0.19,
  "eu-fr": 0.2,
};

/** Sales tax for a region, in cents; regions without a rate are not taxed. */
export function taxFor(amountCents: number, region: string): number {
  const rate = TAX_RATES[region] ?? 0;
  return Math.round(amountCents * rate);
}
