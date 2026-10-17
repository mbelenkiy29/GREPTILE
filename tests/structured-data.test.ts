import test from "node:test";
import assert from "node:assert/strict";
import { homeStructuredData, jsonLd, priceFromLabel } from "../src/structured-data";

const base = { url: "https://openreview.tech", repository: "https://github.com/acme/openreview" };
const offersOf = (data: ReturnType<typeof homeStructuredData>) => (data["@graph"][1] as { offers?: { name: string; price: string }[] }).offers;

test("the seat price is read from its display label, or left out", () => {
  assert.equal(priceFromLabel("$12 per seat / month"), "12");
  assert.equal(priceFromLabel("$ 9.50 per seat"), "9.50");
  assert.equal(priceFromLabel("Per seat, billed monthly"), undefined);
  assert.equal(priceFromLabel(undefined), undefined);
});

test("structured data names the site and app, and lists prices only when billing is on", () => {
  const off = homeStructuredData({ ...base, billing: { enabled: false, trialDays: 14 } });
  assert.deepEqual(off["@graph"].map((n) => n["@type"]), ["WebSite", "SoftwareApplication"]);
  assert.equal(offersOf(off), undefined, "self-hosted deployments show no prices");
  const on = homeStructuredData({ ...base, billing: { enabled: true, trialDays: 14 }, priceLabel: "$12 per seat / month" });
  assert.deepEqual(offersOf(on)?.map((o) => [o.name, o.price]), [["Free trial (14 days)", "0"], ["Starter", "12"]]);
  const unlabeled = homeStructuredData({ ...base, billing: { enabled: true, trialDays: 14 } });
  assert.deepEqual(offersOf(unlabeled)?.map((o) => o.name), ["Free trial (14 days)"], "no made-up price without a label");
});

test("JSON-LD cannot close its script tag", () => {
  assert.equal(jsonLd({ name: "</script><script>alert(1)</script>" }).includes("</script"), false);
  assert.deepEqual(JSON.parse(jsonLd({ a: "<b>" })), { a: "<b>" });
});
