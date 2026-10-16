// Resolve loop: fetch the pull request's unresolved OpenReview findings over MCP, have a coding agent fix
// them, commit locally, push only when the user allows it (never forced), request a re-review of the new
// commit and wait for it, then repeat until no findings remain or the iteration limit is reached.
export type McpCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type LoopFinding = { findingId: string; title: string; severity: string; filePath: string; line: number; suggestedFix?: string; prNumber: number };
export type LoopGit = {
  // Stages and commits all changes; returns the new commit SHA, or null when nothing changed.
  commit(message: string): Promise<string | null>;
  // Plain push of the current branch. Implementations must never force-push.
  push(): Promise<void>;
};
export type LoopOptions = {
  repositoryId: string;
  prNumber: number;
  maxIterations: number;
  push: "never" | "ask" | "always";
  ask?(question: string): Promise<boolean>;
  fix(findings: LoopFinding[], iteration: number): Promise<void>;
  wait(ms: number): Promise<void>;
  pollMs?: number;
  reviewTimeoutMs?: number;
  log?(line: string): void;
};
export type LoopOutcome = "clean" | "max-iterations" | "no-changes" | "push-required" | "push-declined" | "review-timeout" | "review-failed";
export type LoopResult = { outcome: LoopOutcome; iterations: number; remaining: number; commits: string[] };

// argv for the push step: the current branch to its upstream. No --force, --force-with-lease, -f or +refspec.
export const pushArgs = () => ["push"] as const;
export const forbiddenPush = (args: readonly string[]) => args.some((a) => /^(--force|--force-with-lease|--force-if-includes|-f|\+)/.test(a) || /^-[a-zA-Z]*f/.test(a));

const asObject = (value: unknown) => (typeof value === "object" && value ? value : {}) as Record<string, unknown>;
export async function runResolveLoop(call: McpCall, git: LoopGit, o: LoopOptions): Promise<LoopResult> {
  const log = o.log ?? (() => {});
  const commits: string[] = [];
  const findings = async () => ((asObject(await call("list_unresolved_comments", { repositoryId: o.repositoryId })).findings ?? []) as LoopFinding[]).filter((f) => f.prNumber === o.prNumber);
  for (let iteration = 1; iteration <= o.maxIterations; iteration++) {
    const open = await findings();
    if (!open.length) return { outcome: "clean", iterations: iteration - 1, remaining: 0, commits };
    log(`Round ${iteration}: fixing ${open.length} finding${open.length === 1 ? "" : "s"}.`);
    await o.fix(open, iteration);
    const sha = await git.commit(`Address OpenReview findings (round ${iteration})`);
    if (!sha) return { outcome: "no-changes", iterations: iteration, remaining: open.length, commits };
    commits.push(sha);
    if (o.push === "never") return { outcome: "push-required", iterations: iteration, remaining: open.length, commits };
    if (o.push === "ask" && !(await o.ask?.(`Push commit ${sha.slice(0, 7)} so OpenReview can review it?`))) return { outcome: "push-declined", iterations: iteration, remaining: open.length, commits };
    await git.push();
    await call("trigger_review", { repositoryId: o.repositoryId, prNumber: o.prNumber, headSha: sha });
    // Wait for the review of exactly this commit.
    const deadline = Date.now() + (o.reviewTimeoutMs ?? 20 * 60_000);
    for (;;) {
      const review = asObject(asObject(await call("get_review_status", { repositoryId: o.repositoryId, prNumber: o.prNumber })).review);
      if (review.headSha === sha && review.status === "completed") break;
      if (review.headSha === sha && (review.status === "failed" || review.status === "cancelled")) return { outcome: "review-failed", iterations: iteration, remaining: open.length, commits };
      if (Date.now() >= deadline) return { outcome: "review-timeout", iterations: iteration, remaining: open.length, commits };
      await o.wait(o.pollMs ?? 15_000);
    }
  }
  const remaining = (await findings()).length;
  return { outcome: remaining ? "max-iterations" : "clean", iterations: o.maxIterations, remaining, commits };
}
