import { randomUUID } from "node:crypto";
import type { Account, Db, InvoiceRow } from "../db/client.js";
import { insertInvoice } from "../db/invoices.js";
import { applyDiscount, taxFor, type Coupon } from "./pricing.js";

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

/** Computes an invoice: subtotal, coupon discount, then tax on the discounted amount. */
export function buildInvoice(account: Account, lines: LineItem[], coupon: Coupon | null, now = new Date()): InvoiceRow {
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
  const discounted = coupon ? applyDiscount(subtotal, coupon.percentOff) : subtotal;
  const tax = taxFor(discounted, account.region);
  return {
    id: randomUUID(),
    accountId: account.id,
    subtotalCents: subtotal,
    discountCents: subtotal - discounted,
    taxCents: tax,
    totalCents: discounted + tax,
    couponCode: coupon?.code ?? null,
    issuedAt: now,
  };
}

export function issueInvoice(db: Db, account: Account, lines: LineItem[], coupon: Coupon | null): InvoiceRow {
  if (!lines.length) throw new Error("an invoice needs at least one line");
  return insertInvoice(db, buildInvoice(account, lines, coupon));
}
