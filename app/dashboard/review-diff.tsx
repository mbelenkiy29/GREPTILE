import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { DiffFiles, type DiffFinding } from "./diff-files";

// The reviewed change with findings shown inline at their lines (loaded only on request).
export async function ReviewDiff({ token, reviewId, findings, open, finished }: { token: string; reviewId: Id<"reviews">; findings: DiffFinding[]; open: boolean; finished: boolean }) {
  // Running reviews auto-refresh the page; the diff loads only once the review has finished.
  if (!finished) return <section aria-labelledby="diff-heading"><h2 id="diff-heading">Changes</h2><p className="muted">The reviewed diff is available when the review finishes.</p></section>;
  if (!open) return <section aria-labelledby="diff-heading"><h2 id="diff-heading">Changes</h2><p><Link className="button" href={`?diff=1#diff-heading`}>Show the reviewed diff with findings inline</Link></p><p className="muted">Fetches the reviewed revision from the provider on request.</p></section>;
  let diff;
  try { diff = await backend().action(api.reviewDiff.load, { token, reviewId }); }
  catch { return <section aria-labelledby="diff-heading"><h2 id="diff-heading">Changes</h2><p role="alert">The diff could not be loaded from the provider. Check the repository connection and try again.</p></section>; }
  return <section aria-labelledby="diff-heading" className="review-diff">
    <h2 id="diff-heading">Changes</h2>
    {diff.source === "unavailable" ? <p role="status">{diff.reason}</p> : <p className="muted">{diff.source === "compare" ? "Exact base…head comparison" : "Pull request diff"} at {diff.revision.slice(0, 12)} · {diff.files.length} files{diff.omitted ? ` (${diff.omitted} more not shown)` : ""}</p>}
    <DiffFiles files={diff.files} findings={findings} />
  </section>;
}
