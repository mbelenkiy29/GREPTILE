import type { Comparison } from "./incremental";
import { preferenceProblem } from "./conventions";

// Learning from commits. Two outcome signals per finding:
// - addressed: a later commit changed the flagged lines and the review verified the fix;
// - ignored: the pull request merged with the finding still open and no human feedback on it.
// Both feed a bounded per-category preference; neither can ever narrow security review.
export type TrackedFinding = { fingerprint: string; filePath: string; startLine: number; endLine: number };
export type CommitSignal = "addressed" | "ignored";

// Old-side lines a patch touches: removed lines, plus the lines on either side of an insertion.
export function touchedOldLines(patch: string): Set<number> {
  const touched = new Set<number>();
  let old = 0, inHunk = false;
  for (const text of patch.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(text);
    if (hunk) { old = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || text.startsWith("\\")) continue;
    if (text.startsWith("-")) { touched.add(old); old++; }
    else if (text.startsWith("+")) { touched.add(old - 1); touched.add(old); }
    else old++;
  }
  return touched;
}

// Resolved findings attributed to the commits since the last reviewed head. Only a complete "ahead"
// comparison attributes anything: after a force-push or rebase the old lines no longer exist in history.
export function addressedFindings(previous: TrackedFinding[], resolved: string[], comparison: Comparison | "unavailable" | undefined, window = 2) {
  const addressed: string[] = [], unattributed: { fingerprint: string; reason: string }[] = [];
  const done = new Set(resolved);
  const reason = !comparison || comparison === "unavailable" ? "the last reviewed commit could not be compared"
    : comparison.status === "behind" || comparison.status === "diverged" ? "the branch was force-pushed or rebased"
    : comparison.status === "identical" ? "there were no new commits"
    : !comparison.complete ? "the comparison was incomplete" : undefined;
  for (const f of previous.filter((p) => done.has(p.fingerprint))) {
    if (reason || !comparison || comparison === "unavailable") { unattributed.push({ fingerprint: f.fingerprint, reason: reason! }); continue; }
    const file = comparison.files.find((c) => c.path === f.filePath || c.previousPath === f.filePath);
    const lines = file ? (file.status === "removed" ? null : touchedOldLines(file.patch)) : undefined;
    const hit = file && (lines === null || [...lines!].some((l) => l >= f.startLine - window && l <= f.endLine + window));
    if (hit) addressed.push(f.fingerprint);
    else unattributed.push({ fingerprint: f.fingerprint, reason: "resolved without a commit changing the flagged lines" });
  }
  return { addressed, unattributed };
}

// Findings ignored at merge: still open, no human feedback, and part of a review of the merged head.
// If commits landed after the last review, nothing is recorded (they may have fixed the finding).
export function ignoredAtMerge<F extends { status: string; lastFeedback?: string }>(lastReviewFindings: F[], lastReviewedHead: string | undefined, mergedHead: string | undefined): { ignored: F[]; reason?: string } {
  if (!lastReviewedHead) return { ignored: [], reason: "the pull request was never reviewed" };
  if (!mergedHead || mergedHead !== lastReviewedHead) return { ignored: [], reason: "commits after the last review were merged unreviewed" };
  return { ignored: lastReviewFindings.filter((f) => f.status === "open" && !f.lastFeedback) };
}

// Learner bounds: at least `minimum` recent signals in the category and a clear (≥ threshold) majority.
// A majority of ignored findings asks for stronger evidence, never silence, and never for security.
export const commitLearning = { minimum: 5, threshold: 0.7, recent: 50, maxAgeDays: 180 };
export function commitPreference(category: string, counts: { addressed: number; ignored: number }, bounds = commitLearning): string | null {
  const total = counts.addressed + counts.ignored;
  if (total < bounds.minimum) return null;
  const label = category === "rules" ? "custom-rule" : category;
  let instruction: string | null = null;
  if (counts.addressed / total >= bounds.threshold)
    instruction = `Authors fixed ${counts.addressed} of the last ${total} ${label} findings in this repository with a follow-up commit; keep reporting ${label} issues backed by this kind of evidence.`;
  else if (counts.ignored / total >= bounds.threshold && !/secur/i.test(category))
    instruction = `Authors merged ${counts.ignored} of the last ${total} ${label} findings in this repository without changing the flagged code; report ${label} issues only when the evidence shows a concrete defect and its impact.`;
  return instruction && !preferenceProblem(instruction, category) ? instruction : null;
}
