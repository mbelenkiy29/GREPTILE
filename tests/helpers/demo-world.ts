import { cpSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Candidate } from "@/lib/engine";
import { loadScenario, DEMO_FIXTURE_DIR } from "@/lib/local-demo";
import { FixtureRepo } from "./fixture-repo";

/** The demo fixture's scenario (repository, pull request, fix, and the known cross-file bug). */
export const demoScenario = () => loadScenario();

/**
 * A working repository holding `fixtures/demo-repo/base` on `main` (commit `base`) and, on `branch`, the pull request's
 * change (commit `head`). `applyFix()` commits the fix on top and returns its sha.
 */
export function demoCheckout(branch = "discount-cap") {
  const fixture = new FixtureRepo();
  cpSync(path.join(DEMO_FIXTURE_DIR, "base"), fixture.dir, { recursive: true });
  fixture.git("add", "-A");
  fixture.git("commit", "--quiet", "-m", "Initial import of payments-service");
  const base = fixture.git("rev-parse", "HEAD");
  fixture.git("checkout", "--quiet", "-b", branch);
  cpSync(path.join(DEMO_FIXTURE_DIR, "pr"), fixture.dir, { recursive: true });
  fixture.git("add", "-A");
  fixture.git("commit", "--quiet", "-m", "Cap coupon discounts at a plan maximum");
  const head = fixture.git("rev-parse", "HEAD");
  const applyFix = () => {
    cpSync(path.join(DEMO_FIXTURE_DIR, "fix"), fixture.dir, { recursive: true });
    fixture.git("add", "-A");
    fixture.git("commit", "--quiet", "-m", "Keep applyDiscount's original argument order");
    return fixture.git("rev-parse", "HEAD");
  };
  return { fixture, base, head, applyFix };
}

/**
 * The correctness reviewer's finding for the demo bug, as written in the offline recording: applyDiscount's
 * parameters were swapped while its caller in src/billing/invoices.ts (outside the diff) was not updated.
 */
export function demoBugCandidate(): Candidate {
  const recording = JSON.parse(readFileSync(path.join(DEMO_FIXTURE_DIR, "recorded", "review.json"), "utf8")) as {
    calls: { key: string; response: { findings?: Candidate[] } }[];
  };
  const finding = recording.calls.find((c) => c.key === "review:correctness")?.response.findings?.[0];
  if (!finding) throw new Error("the demo recording has no correctness finding");
  return finding;
}
