import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount, taxFor } from "../src/billing/pricing.ts";

test("applyDiscount takes a percentage off and never goes below zero", () => {
  assert.equal(applyDiscount(10_000, 20), 8_000);
  assert.equal(applyDiscount(10_000, 0), 10_000);
  assert.equal(applyDiscount(10_000, 150), 0);
});

test("taxFor uses the region's rate", () => {
  assert.equal(taxFor(10_000, "eu-de"), 1_900);
  assert.equal(taxFor(10_000, "nowhere"), 0);
});
