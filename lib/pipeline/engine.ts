/**
 * The pipeline's seam to the review engine (S39). The pipeline calls the engine only through the shared contract in
 * `lib/engine/types.ts`; `ReviewJobDeps.runReview` injects an implementation (tests may use a stub that returns canned
 * `ReviewOutput`s). Without one, the job uses the real engine.
 */
import { runReview } from "@/lib/engine";
import type { EngineDeps, ReviewOutput, ReviewRequest } from "@/lib/engine/types";

export { creditsFor } from "@/lib/engine";

export type RunReview = (deps: EngineDeps, req: ReviewRequest) => Promise<ReviewOutput>;

/** The engine used when none is injected. */
export const defaultRunReview: RunReview = runReview;
