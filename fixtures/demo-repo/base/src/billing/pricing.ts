/**
 * Price calculations for invoices. All amounts are integer cents.
 */

export interface Coupon {
  code: string;
  percentOff: number;
}

/** Applies a percentage discount to an amount, never going below zero. */
export function applyDiscount(amountCents: number, percentOff: number): number {
  if (percentOff <= 0) return amountCents;
  const discounted = Math.round(amountCents * (1 - percentOff / 100));
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
