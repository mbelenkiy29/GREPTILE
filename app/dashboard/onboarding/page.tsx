import { redirect } from "next/navigation";
import { resolveStep } from "../../../src/onboarding-steps";
import { loadSetup } from "./setup";

// /dashboard/onboarding resumes at the first step still needed.
export default async function SetupIndex() {
  const { state } = await loadSetup();
  redirect(`/dashboard/onboarding/${resolveStep(undefined, state)}`);
}
