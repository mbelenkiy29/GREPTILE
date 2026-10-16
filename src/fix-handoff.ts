import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { findingSchema } from "./engine/types";
import { fixPrompt } from "./fix-prompt";
import { backend } from "./server";

// The portable fix prompt for a review (or one finding by fingerprint), built on the server from the
// reader's own view of the review: the same text the bridge, copy button and agent links use.
export async function fixHandoffPrompt(token: string, reviewId: Id<"reviews">, fingerprint?: string) {
  const detail = await backend().query(api.reviews.detail, { token, reviewId });
  const selected = fingerprint ? detail.findings.find((f) => f.fingerprint === fingerprint) : undefined;
  if (fingerprint && !selected) throw new Error("This finding is no longer available in this review");
  const eligible = (selected ? [selected] : detail.findings).filter((f) => f.canFix);
  if (!eligible.length) throw new Error("No findings in this review can be handed off");
  const repository = (await backend().query(api.repositories.list, { token, organizationId: detail.review.organizationId }).catch(() => [])).find((r) => r._id === detail.review.repositoryId);
  const name = repository?.fullName ?? "the repository";
  const prompt = fixPrompt(name, `PR #${detail.review.prNumber}`, eligible.map((f) => ({ ...findingSchema.parse(f), agent: f.agent, fingerprint: f.fingerprint, commitSha: f.commitSha })), detail.review.runtimeEvidence);
  return { prompt, title: `${selected ? selected.title : "Fix OpenReview findings"} (${name} #${detail.review.prNumber})` };
}
