import type { Metadata } from "next";
import { LandingPage } from "@/components/marketing/LandingPage";
import { demoEnv } from "@/lib/env";

// Rendered per request: whether the public demo is on (DEMO_ENABLED) is a runtime setting of each deployment.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "OpenReview — open-source AI code review with full-codebase context" },
  description:
    "OpenReview reviews pull requests with the context of the whole repository, verifies every finding before it comments, and learns your team's conventions. AGPL-3.0, self-hostable, bring your own model.",
  alternates: { canonical: "/" },
};

export default function Home() {
  return <LandingPage demoEnabled={demoEnv().DEMO_ENABLED} />;
}
