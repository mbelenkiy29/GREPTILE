import type { ChangedFile } from "./engine/types";

// Incremental review: when the last reviewed head is an ancestor of the new head, review only
// the new commits' changes (restricted to files still changed by the pull request) while the full
// PR stays available as context. Force-pushes, rebases and incomplete comparisons review everything.
export type Comparison = { status: "ahead" | "behind" | "diverged" | "identical"; commits: number; complete: boolean; files: ChangedFile[] };
export function incrementalDiff(prDiff: ChangedFile[], previousHead: string | undefined, comparison: Comparison | undefined | "unavailable") {
  if (!previousHead) return { diff: prDiff, incremental: false as const };
  const short = previousHead.slice(0, 7);
  if (comparison === "unavailable" || !comparison) return { diff: prDiff, incremental: false as const, note: `Could not compare with the last reviewed commit ${short}; the full pull request was reviewed.` };
  if (comparison.status === "behind" || comparison.status === "diverged") return { diff: prDiff, incremental: false as const, note: `The branch was force-pushed or rebased since the last reviewed commit ${short}; the full pull request was reviewed again.` };
  if (comparison.status !== "ahead" || !comparison.complete) return { diff: prDiff, incremental: false as const, ...(comparison.status === "ahead" ? { note: `Changes since ${short} were too large to compare; the full pull request was reviewed.` } : {}) };
  const stillChanged = new Set(prDiff.map((d) => d.path));
  const diff = comparison.files.filter((f) => stillChanged.has(f.path));
  if (!diff.length) return { diff: prDiff, incremental: false as const, note: `New commits since ${short} only touched files the pull request no longer changes; the full pull request was reviewed.` };
  return { diff, incremental: true as const, note: `Incremental review: ${comparison.commits} new commit${comparison.commits === 1 ? "" : "s"} since ${short} changed ${diff.length} file${diff.length === 1 ? "" : "s"}; earlier changes were reviewed at ${short} and the full pull request was used as context.` };
}
