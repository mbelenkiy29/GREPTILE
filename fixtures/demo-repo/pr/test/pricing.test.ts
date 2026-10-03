import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount, taxFor } from "../src/billing/pricing.ts";

test("applyDiscount takes a percentage off and never goes below zero", () => {
  assert.equal(applyDiscount(20, 10_000), 8_000);
  assert.equal(applyDiscount(0, 10_000), 10_000);
});

test("applyDiscount caps the discount at the plan maximum", () => {
  assert.equal(applyDiscount(50, 10_000), 7_000);
  assert.equal(applyDiscount(50, 10_000, 60), 5_000);
});

test("taxFor uses the region's rate", () => {
  assert.equal(taxFor(10_000, "eu-de"), 1_900);
  assert.equal(taxFor(10_000, "nowhere"), 0);
});
