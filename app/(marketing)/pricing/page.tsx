import type { Metadata } from "next";
import { PricingView } from "@/components/marketing/PricingView";
import { billingConfig } from "@/lib/billing/plans";
import { creditsFor } from "@/lib/engine/modes";

// Rendered per request from this deployment's billing configuration (the same one Stripe checkout uses).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing",
  description: "OpenReview plans and credits. Self-hosting is free forever under the AGPL-3.0.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return <PricingView config={billingConfig()} credits={{ fast: creditsFor("fast"), standard: creditsFor("standard"), deep: creditsFor("deep") }} />;
}
