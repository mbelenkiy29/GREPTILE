import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import type { BillingConfig, Plan } from "@/lib/billing/plans";
import { offeredPlans } from "@/lib/billing/plans";

export interface ModeCredits {
  fast: number;
  standard: number;
  deep: number;
}

const usd = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

function PlanPrice({ plan }: { plan: Plan }) {
  if (plan.priceUsd === 0) {
    return (
      <p className="p-price">
        <span className="p-amount">$0</span>
        <span className="p-unit">{plan.id === "self_hosted" ? "forever" : "per month"}</span>
      </p>
    );
  }
  return (
    <p className="p-price">
      <span className="p-amount">{usd(plan.priceUsd)}</span>
      <span className="p-unit">{plan.perSeat ? "per seat / month" : "per month"}</span>
    </p>
  );
}

function PlanCard({ plan, cta }: { plan: Plan; cta: { href: string; label: string } }) {
  const titleId = `plan-${plan.id}`;
  return (
    <article className={`p-plan${plan.id === "team" ? " p-plan-featured" : ""}`} data-plan={plan.id} aria-labelledby={titleId}>
      <h2 id={titleId}>{plan.name}</h2>
      <p className="p-tagline">{plan.tagline}</p>
      <PlanPrice plan={plan} />
      {plan.overagePriceUsd !== null && (
        <p className="p-overage" data-overage="">
          Beyond the included credits: {usd(plan.overagePriceUsd)} per credit, metered monthly.
        </p>
      )}
      <ul className="p-features">
        {plan.features.map((f) => (
          <li key={f}>
            <Icon name="check" size={16} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link href={cta.href} className={`button button-lg button-block${plan.id === "team" ? " button-primary" : ""}`}>
        {cta.label}
      </Link>
    </article>
  );
}

/**
 * The pricing page (R5.2), rendered from the same plan configuration Stripe checkout and usage enforcement read
 * (`lib/billing/plans.ts`): the hosted plans appear only when this instance has billing configured, and the
 * self-hosted option is always shown.
 */
export function PricingView({ config, credits }: { config: BillingConfig; credits: ModeCredits }) {
  const hosted = offeredPlans(config).filter((p) => p.id !== "self_hosted");
  const self = config.plans.self_hosted;
  return (
    <div className="m-wrap p-page">
      <header className="m-section-head p-head">
        <p className="m-eyebrow">Pricing</p>
        <h1 className="m-display" id="pricing-title">
          {hosted.length ? "Simple plans. Or run it yourself, free." : "Free to run yourself."}
        </h1>
        <p className="m-lede">
          {hosted.length
            ? "Use this instance on a plan below, or self-host OpenReview at no cost under the AGPL-3.0."
            : "This instance does not sell plans. OpenReview is free software: run it on your own server with your own model provider."}
        </p>
      </header>

      <div className={`p-plans p-plans-${hosted.length + 1}`}>
        {hosted.map((p) => (
          <PlanCard key={p.id} plan={p} cta={{ href: "/sign-in", label: p.id === "free" ? "Start free" : `Choose ${p.name}` }} />
        ))}
        <PlanCard plan={self} cta={{ href: "/docs/self-hosting", label: "Self-hosting guide" }} />
      </div>
      <p className="p-selfhost-note" data-selfhost-note="">
        <strong>Self-hosted: free forever, AGPL-3.0.</strong> Every feature, unlimited developers and reviews. You pay only your server and your model
        provider. <Link href="/docs/self-hosting">Read the self-hosting guide</Link>.
      </p>

      <section className="p-faq" aria-labelledby="pricing-faq">
        <h2 id="pricing-faq">Credits and review modes</h2>
        <dl>
          <div>
            <dt>What is a credit?</dt>
            <dd>
              The unit reviews are counted in. A review consumes credits according to its mode:{" "}
              <span data-credits="fast">Fast {credits.fast}</span>, <span data-credits="standard">Standard {credits.standard}</span>, and{" "}
              <span data-credits="deep">Deep {credits.deep}</span>.
            </dd>
          </div>
          <div>
            <dt>How do the modes differ?</dt>
            <dd>
              Fast runs fewer specialized reviewers with a smaller context budget; Standard (the default) suits everyday pull requests; Deep runs every
              reviewer, follows dependents further through the code graph, and uses the most capable model settings. See{" "}
              <Link href="/docs/review-modes">Review modes &amp; cost</Link>.
            </dd>
          </div>
          {hosted.some((p) => p.perSeat) && (
            <div>
              <dt>Who counts as a seat?</dt>
              <dd>Every developer whose pull requests were reviewed in the billing period. People who only read reviews or configure OpenReview are not seats.</dd>
            </div>
          )}
          {hosted.some((p) => p.overagePriceUsd !== null) && (
            <div>
              <dt>What happens when credits run out?</dt>
              <dd>On Team, extra credits are billed as metered overage. Owners can set a hard cap and alert thresholds.</dd>
            </div>
          )}
          {hosted.some((p) => p.id === "free") && (
            <div>
              <dt>What does the free plan include?</dt>
              <dd>One active developer and a monthly credit allowance. When the allowance is used up, reviews pause until the next period.</dd>
            </div>
          )}
          <div>
            <dt>Do credits apply when I self-host?</dt>
            <dd>Credits are still counted so you can see usage and set caps, but nothing is billed. Operators set the credit cost of each mode.</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
