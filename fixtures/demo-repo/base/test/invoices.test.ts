import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInvoice } from "../src/billing/invoices.ts";

const account = { id: "acct_1", name: "Acme", region: "us-ny" };

test("buildInvoice discounts before tax", () => {
  const invoice = buildInvoice(account, [{ description: "Seats", quantity: 4, unitPriceCents: 2_500 }], { code: "LAUNCH20", percentOff: 20 });
  assert.equal(invoice.subtotalCents, 10_000);
  assert.equal(invoice.discountCents, 2_000);
  assert.equal(invoice.taxCents, 320);
  assert.equal(invoice.totalCents, 8_320);
});
