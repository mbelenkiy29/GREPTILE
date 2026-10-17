import type { Metadata } from "next";
import { LegalPage } from "../legal";

export const metadata: Metadata = { title: "Terms of Service", description: "The terms for using the hosted OpenReview service.", alternates: { canonical: "/terms" } };
export default function Terms() {
  return <LegalPage name="terms" />;
}
