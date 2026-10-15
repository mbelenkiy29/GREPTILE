import type { Metadata } from "next";
import { LegalPage } from "../legal";

export const metadata: Metadata = { title: "Privacy Policy", description: "What the hosted OpenReview service collects, how it is used and shared, and your choices." };
export default function Privacy() {
  return <LegalPage name="privacy" />;
}
