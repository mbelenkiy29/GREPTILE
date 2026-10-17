// Search metadata for the public site: the shared description, and schema.org structured data
// (JSON-LD) for the home page that gives search engines the site's name and describes the app,
// its licence, its source and, when billing is on, its prices.
import type { BillingConfig } from "./billing";

export const siteDescription = "Repository-aware pull request reviews with exact-quote evidence. Self-host it or use the cloud.";

/** The amount in a price label such as "$12 per seat / month"; undefined when the label has none. */
export function priceFromLabel(label?: string) {
  return label?.match(/\$\s?(\d+(?:\.\d{1,2})?)/)?.[1];
}

export function homeStructuredData({ url, repository, billing, priceLabel }: { url: string; repository: string; billing: Pick<BillingConfig, "enabled" | "trialDays">; priceLabel?: string }) {
  const price = priceFromLabel(priceLabel);
  const offers = billing.enabled ? [
    { "@type": "Offer", name: `Free trial (${billing.trialDays} days)`, price: "0", priceCurrency: "USD" },
    ...(price ? [{ "@type": "Offer", name: "Starter", price, priceCurrency: "USD", priceSpecification: { "@type": "UnitPriceSpecification", price, priceCurrency: "USD", unitText: "seat per month" } }] : []),
  ] : [];
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "OpenReview", url },
      { "@type": "SoftwareApplication", name: "OpenReview", applicationCategory: "DeveloperApplication", operatingSystem: "Web", url, description: siteDescription, license: "https://opensource.org/licenses/MIT", sameAs: [repository], ...(offers.length ? { offers } : {}) },
    ],
  };
}

/** JSON for a `<script type="application/ld+json">`, safe to place inside HTML. */
export const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
