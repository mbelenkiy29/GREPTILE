import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PricingView } from "@/components/marketing/PricingView";
import { billingConfig, offeredPlans, type BillingConfig } from "@/lib/billing/plans";
import { creditsFor } from "@/lib/engine/modes";
import { billingEnv } from "@/lib/env";

// Built at runtime so no provider-key-shaped literal is committed.
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: ["sk", "test", "pricing", "fixture"].join("_"),
  STRIPE_WEBHOOK_SECRET: ["whsec", "pricing", "fixture"].join("_"),
  STRIPE_PRICE_TEAM_SEAT: "price_team_seat",
  STRIPE_PRICE_OVERAGE: "price_overage",
};

const off: BillingConfig = billingConfig(billingEnv({ APP_URL: "https://review.example.com" }));
const on: BillingConfig = billingConfig(
  billingEnv({ APP_URL: "https://review.example.com", ...STRIPE_ENV, TEAM_SEAT_PRICE_USD: "31", OVERAGE_CREDIT_PRICE_USD: "0.35", FREE_MONTHLY_CREDITS: "70", TEAM_INCLUDED_CREDITS_PER_SEAT: "250" }),
);

const render = (config: BillingConfig, credits = { fast: 1, standard: 2, deep: 4 }) => renderToStaticMarkup(<PricingView config={config} credits={credits} />);
const planIds = (html: string) => [...html.matchAll(/data-plan="([^"]+)"/g)].map((m) => m[1]);

describe("pricing page", () => {
  test("R5.2 with billing off shows only the self-hosted plan, from the plan config", () => {
    const html = render(off);
    expect(planIds(html)).toEqual(["self_hosted"]);
    expect(offeredPlans(off).map((p) => p.id)).toEqual(["self_hosted"]);
    for (const f of off.plans.self_hosted.features) expect(html).toContain(f);
    expect(html).toContain("Self-hosted: free forever, AGPL-3.0.");
    expect(html).toContain('href="/docs/self-hosting"');
    expect(html).not.toContain("data-overage");
    expect(html).not.toContain(off.plans.team.name);
  });

  test("R5.2 with billing on shows Free and Team with prices, overage, and features from the same config Stripe uses", () => {
    const html = render(on);
    expect(planIds(html)).toEqual(["free", "team", "self_hosted"]);
    const team = on.plans.team;
    expect(html).toContain(`$${team.priceUsd}`);
    expect(team.priceUsd).toBe(31);
    expect(html).toContain("per seat / month");
    expect(html).toContain(`$${team.overagePriceUsd!.toFixed(2)} per credit`);
    for (const plan of [on.plans.free, team, on.plans.self_hosted]) {
      for (const f of plan.features) expect(html).toContain(f);
      expect(html).toContain(plan.tagline.replace(/'/g, "&#x27;"));
    }
    expect(html).toContain("70 review credits per month");
    expect(html).toContain("250 credits per seat per month");
    // The self-hosted option is always offered.
    expect(html).toContain("Self-hosted: free forever, AGPL-3.0.");
    expect(html.match(/data-overage=""/g)).toHaveLength(1);
  });

  test("R5.2 credits FAQ shows each mode's credit cost from creditsFor", () => {
    const credits = { fast: creditsFor("fast", { CREDITS_FAST: "3" }), standard: creditsFor("standard", { CREDITS_STANDARD: "5" }), deep: creditsFor("deep", { CREDITS_DEEP: "9" }) };
    const html = render(on, credits);
    expect(html).toMatch(/data-credits="fast">Fast 3</);
    expect(html).toMatch(/data-credits="standard">Standard 5</);
    expect(html).toMatch(/data-credits="deep">Deep 9</);
    expect(html).toContain("Who counts as a seat?");
    expect(render(off)).not.toContain("Who counts as a seat?");
  });
});
